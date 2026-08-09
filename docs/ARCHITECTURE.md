# Flight OTA on Hyperswitch — Architecture & Decisions

*Prototype: https://flight-ota-hyperswitch.vercel.app · Repo: https://github.com/AravindKurapati/flight-ota-hyperswitch · Full decision ledger: [DECISIONS.md](../DECISIONS.md) · Schema: [SCHEMA.md](../SCHEMA.md)*

## 1. The problem shape

We are a US online travel agency selling flights as **merchant of record**: the
traveller pays us, we settle with the airline separately. That single fact
drives everything in this design, because it creates a window where the two
things that must stay synchronized — the traveller's money and the airline's
ticket — are moved by two different systems that can each fail independently.

The invariant the whole system is built around: **capture never precedes
ticket issuance.** A traveller must never be charged for a ticket that does
not exist. The reverse (a ticket issued but capture fails) is an
accounts-receivable problem; the former is a refund queue, a dispute
magnet, and a trust failure. So the flight payment is authorized at checkout
(`capture_method: manual`), held while we attempt issuance, and captured only
after a ticket number exists. Terminal issuance failure voids the
authorization — the money is released, not refunded, which is faster for the
traveller and free for us.

**Stack.** Next.js (App Router) on Vercel; Neon Postgres via Drizzle; the
Hyperswitch hosted sandbox as the payments layer, with the unified-checkout
SDK in the browser and the REST API server-side. The API key lives only in
server-side env; the repo is public and nothing secret reaches the browser.

**Connectors and routing.** Two connectors, chosen by what we could actually
verify live rather than what exists in a config file: `authorizedotnet`
(capture, void, and refund verified against the live sandbox) carries flights,
and `fauxpay` (Hyperswitch's dummy connector — authorizes but can never
capture, strands funds) is deliberately quarantined to sub-$50 payments by a
routing rule (`amount < $50 → fauxpay`). That rule is what makes the $24 trip
protection add-on safe to auto-confirm server-side with a published test card:
it can only ever land on the synthetic connector. Stripe was integrated first
and then **removed** (D-012) when we found the server-side confirm path put
raw PANs on our secret-key path — the sandbox-only shortcut would have been a
PCI scope violation shaped exactly like a real one.

## 2. The booking state machine

```
QUOTED ──AUTH_SUCCEEDED──► AUTHORIZED ──ISSUANCE_STARTED──► TICKETING ──ISSUANCE_SUCCEEDED──► TICKETED
   │  ▲                        │                              │      ▲                            │
   │  └──RETRY── PAYMENT_FAILED│                              └──────┘                            │
   │        (◄─AUTH_DECLINED───┘ intent reused)          ISSUANCE_FAILED_RETRYABLE     REFUNDED_PARTIAL
   │                           │                              │                                   ▼
   └───────────────────────────┴──CANCELLED_IN_WINDOW──► VOIDED ◄──ISSUANCE_FAILED_TERMINAL   PARTIALLY_REFUNDED ─►REFUNDED
```

Bookings move only through this table — there is no code path that writes a
state the table doesn't permit, an unknown state throws a named error rather
than a `TypeError`, and every transition is recorded in an append-only
`booking_events` log. Three transitions carry the interesting decisions:

- **Decline → retry reuses the payment intent.** A declined card returns the
  booking to QUOTED against the same intent, so Hyperswitch records attempt
  #2 on the same payment — one payment history per purchase, not a trail of
  abandoned intents.
- **The US DOT 24-hour rule is a void, not a refund** (`cancelWithinWindow`):
  inside the window the authorization is released; money that was never
  captured needs no refund rail. TICKETED bookings are pointed at the refund
  flow instead.
- **PARTIALLY_REFUNDED self-loops** so successive partial refunds accumulate
  until the captured amount is reached, then the booking is terminal.

## 3. Correctness under retries and ambiguity

Payments code fails in a specific, nasty way: the request times out and you
do not know whether the remote side acted. Three mechanisms handle this:

**Idempotency by owned identifiers (D-010/D-011).** We mint every identifier
we send: `hs_payment_id` and `refund_id` are our ULIDs passed to Hyperswitch,
so an ambiguous failure is resolved by *reading back* our own identifier
(`createIntentOrReadBack`, `chargeOrReadBack`), never by retrying blind. If
the read-back finds the object, the first request landed; if not, it didn't.

**`withIdempotency` with a release-only-on-throw contract (D-013).** Every
money-moving endpoint runs under a keyed idempotency record. The contract is
precise: the key is released if and only if the wrapped function throws, and
the function must resolve ambiguous remote failures via read-back *before*
throwing. Replays return the stored response; concurrent claims 409.

**Database constraints as the last line.** One flight and one protection
payment per booking (partial unique index), one refund per (payment, reason),
positive amounts — the checks that hold even if application logic is wrong.
The trip-protection flow inserts its payment row *before* charging, so a
duplicate is rejected by the index before any money moves.

**The connector capability table (D-007)** encodes what each connector was
*proven* to do (`capture`/`void`/`refund` per verified probe, `mit: SOURCE
ONLY` where only source code, not a live test, supports the claim). Issuance
and protection assert capability before acting, and the webhook handler
treats a payment reported on an incapable connector as a misroute: void it,
record `capability.violation`, keep serving. This guardrail earned its keep
twice — it is why fauxpay can never strand a flight fare, and why the
unverifiable MIT path refuses cleanly instead of attempting a charge.

## 4. Webhooks, reconciliation, and what going live taught us

The webhook endpoint verifies an HMAC-SHA512 signature over the raw bytes
before parsing, applies **monotonic** state advances (unordered, at-least-once
deliveries must never move a payment backwards), always ACKs 200 once the
signature passes, and reads optional payload fields with an explicit
undefined-vs-null discipline — "field absent from this delivery" and "field
present and null" mean different things and are handled differently.

The `/ops` console shows stored state and live Hyperswitch state side by
side and flags divergence. The posture throughout is **reconciliation is
surfaced, not automated** (D-011): rare, visible human tasks beat silent
compensating writes driven by unordered events.

That posture was tested the day we deployed. The hosted walkthrough's $100
refund returned HTTP 200 — with `status: "failed"`: Authorize.net refuses to
credit a capture that hasn't settled (error 54; settlement is a nightly
batch). Two bugs compounded (D-024): we had treated *acceptance* of the
refund request as *success* and advanced the booking; then the refund-failed
webhook, which carries the payment's id inside its object, was applied by the
generic advance to the payment row itself — a captured payment relabelled
"failed" by its own refund's failure. The ops console's divergence flag is
what caught it. The fixes: `refundBooking` treats `status: "failed"` as a
recorded, retryable failure that never advances the booking; refund events
land only on the refunds row; async failures surface as `refund.failed`
events for a human. Reproducing tests were written before either fix.

## 5. Verified live vs. deferred

Every claim above about connector behaviour comes from a live probe recorded
in DECISIONS.md (V-001 – V-005): the full book → authorize → issue → capture
path, terminal-failure void, DOT-window void, webhook HMAC verification on a
real delivery, and the refund-settlement behaviour were all exercised against
the hosted deployment. Two things remain deferred honestly rather than
demonstrated dishonestly: **MIT ancillary charging** (the SDK's save-card
path fails client-side before any network call, so no `payment_method_id` is
ever stored — the endpoint refuses cleanly) and everything in the deferred
table (disputes, FRM, BNPL, multi-currency, BSP/ARC settlement) where the
sandbox cannot produce a real lifecycle. Known simplifications are stated in
the README: the ops console is unauthenticated, and the retryable-issuance
counter is per-instance memory.

The through-line we'd defend in review: **nothing in this system claims more
than was verified, and every place where reality can diverge from our record
is either constrained (indexes, state machine), read back (owned IDs), or
surfaced to a human (ops console, event log).**
