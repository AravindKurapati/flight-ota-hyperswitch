# DECISIONS

Every payment behaviour decision: what we chose, what we rejected, why.

Newest first within each section. Dates are the date the decision was taken.

---

## Environment and credentials

### D-001 · Stripe test-mode connector is in scope · 2026-08-05

> **Superseded by D-012 on 2026-08-06.** The reasoning below still holds — the flow
> needs a capture-capable PSP and the dummy connector is not one. Only the choice of
> PSP changed, after Stripe turned out to be unusable. Kept rather than rewritten,
> because the reason we moved is more informative than the destination.

**Chose:** Stripe in test mode (`sk_test_`) as the primary connector.
**Rejected:** dummy connectors only.
**Why:** The dummy connector cannot capture, void, or store a payment method —
verified from source. Without a test-mode PSP the core travel flow (hold at booking,
capture at ticketing, void on failure) is not demonstrable at all and the prototype
degrades to a generic checkout. A Stripe test account moves no money and carries no
business details.

This narrows the project rule from "no real PSP credentials" to **no *live* PSP
credentials**. Test-mode keys are in scope. The Hyperswitch API key and `sk_test_` are
server-side only and never reach the browser.

### D-012 · Authorize.net replaces Stripe as the capture-capable connector · 2026-08-06

**Chose:** Authorize.net sandbox as the connector for flight bookings.
**Rejected:** Stripe test mode (D-001); waiting on Stripe's raw-card-data review;
Braintree.
**Why:** Stripe cannot process cards for this integration at all, for a structural
reason rather than a configuration mistake.

Hyperswitch is an orchestrator: the card reaches Hyperswitch's servers and Hyperswitch
forwards it to the PSP. Its Stripe connector sends
`payment_method_data[card][number]` — the raw PAN — to `v1/payment_intents`, and
authenticates every request with `Bearer {secret_key}`
(`crates/hyperswitch_connectors/src/connectors/stripe/transformers.rs:310`,
`stripe.rs:157`). Stripe blocks raw card data on the secret-key path by default:

> Sending credit card numbers directly to the Stripe API is generally unsafe.

The dashboard's "Handle card information directly" toggle lifts it, but on a new
account that toggle is gated behind full business activation — legal entity, tax
details, an account representative's SSN, business owners, and a bank account. That is
live-credential territory, which the project rules place on the deferred list, and it
is not a reasonable thing to submit for a prototype.

The adjacent toggle we *did* have — "enable card data collection with a publishable key"
— does not help, because Hyperswitch never uses a Stripe publishable key. Verified from
source before switching, not assumed.

Authorize.net was chosen over Braintree because its connector has zero `NotImplemented`
paths and its credentials are two fields (API Login ID, Transaction Key) against
Braintree's GraphQL setup and three. Sandbox signup is instant with no KYC. Capability
verified from source before committing to it:

| Need | Authorize.net transaction type |
| --- | --- |
| Authorize without charging | `authOnlyTransaction` (from `capture_method: manual`) |
| Capture after ticket issuance | `priorAuthCaptureTransaction` |
| Void inside the DOT 24h window | `voidTransaction` |
| Refund after ticketing | `refundTransaction` |

**What this cost:** no application code. Connector choice is dashboard configuration and
a routing rule; `lib/hyperswitch.ts` was untouched. That is the orchestration layer
doing exactly what it exists to do, and it is the strongest evidence in this prototype
that the abstraction is real rather than decorative.

**Known limitation:** Hyperswitch rejects `manual_multiple` on Authorize.net, so
repeated partial captures are unavailable. A single partial capture works and is
verified. Our design captures once, so this does not bind.

**Stripe is left connected but unused,** so the finding stays reproducible.

---

## Capture and fulfilment

### D-002 · Manual capture for flight bookings · 2026-08-05

**Chose:** `capture_method: manual` on every flight authorization; capture only after a
ticket number exists.
**Rejected:** auto-capture at checkout with refund-on-failure.
**Why:** As merchant of record we do not own the seat at checkout. Auto-capture would
charge travellers for seats we may fail to obtain, then require a refund — which costs
interchange, takes days to reach the traveller, and generates support contacts and
disputes. Voiding an uncaptured authorization is free and immediate.

This is also what makes DOT 24-hour cancellation cheap (see D-003).

### D-003 · DOT 24-hour cancellations are voids, not refunds · 2026-08-05

**Chose:** cancellation within the 24-hour window, while still `AUTHORIZED`, releases
the authorization.
**Rejected:** treating all cancellations uniformly as refunds.
**Why:** 14 CFR 259.5 requires a 24-hour hold-or-refund on qualifying itineraries. If
we have not captured, a void returns the traveller's funds immediately at no processing
cost. Uniform refund handling would be simpler code and strictly worse economics and
customer experience.

### D-004 · Ticketing failures are classified retryable vs terminal · 2026-08-05

**Chose:** retryable failures hold funds and permit another issuance attempt; terminal
failures void immediately.
**Rejected:** voiding on any failure; retrying indefinitely on any failure.
**Why:** Voiding on a transient GDS timeout discards recoverable bookings and forces
the traveller to rebook at a possibly higher fare. Retrying on a terminal failure
(fare withdrawn) holds the traveller's funds against a seat that will never exist.

---

## Routing and connectors

### D-005 · Trip protection routes to a second connector · 2026-08-05

**Chose:** rule-based routing on amount — under $50 to `fauxpay`, everything else to the
capture-capable connector (Stripe when written, Authorize.net since D-012).
**Rejected:** routing on `capture_method`; a blind primary/fallback pair.
**Why:** `capture_method` is not an available routing dimension (documented dimensions
are payment method, payment method type, amount, currency, country, card type, card
network), so the intuitive rule is not expressible. Amount cleanly separates the two
products, which do not overlap in price.

Business justification rather than demo contrivance: trip protection is underwritten by
a third party, not the OTA, and settling it through a separate processor reflects the
real commercial arrangement.

### D-006 · The dummy connector is excluded from default fallback · 2026-08-05

**Chose:** Default Fallback Routing lists the capture-capable connector only —
Authorize.net since D-012, Stripe when this was written. Never `fauxpay`.
**Rejected:** the conventional "list every connector as fallback" configuration.
**Why:** A fallback exists to catch a payment when the preferred processor cannot take
it. If a flight authorization fell back onto `fauxpay` it would succeed and then be
permanently stuck — no capture, no void, traveller's funds held with no way to release
them. A fallback that can strand money is worse than no fallback.

### D-007 · Connector capability is asserted at runtime · 2026-08-05

**Chose:** a static capability table; after authorization, verify the chosen connector
supports what this payment kind will need. A flight authorization on a
capture-incapable connector is voided immediately and the booking fails loudly.
**Rejected:** pinning `connector: ["stripe"]` on every flight intent.
**Why:** Pinning would work but would make the routing rule decorative — the
orchestration layer would no longer be deciding anything. Asserting instead lets
routing do its job while making the capability constraint explicit and enforced.
Capability is treated as a property of the system, not an assumption held in someone's
head.

---

## Authentication

### D-008 · `no_three_ds` on the booking flow · 2026-08-05

**Chose:** explicit `no_three_ds` for US domestic card bookings.
**Rejected:** the v1 API default, which is `three_ds`.
**Why:** Two reasons. US domestic card-not-present does not require SCA, and OTA
checkout is acutely conversion-sensitive on high-value baskets. Separately, a 3DS
challenge disqualifies a payment from automatic retry handling, which would break the
decline-and-retry flow.

**Production caveat, recorded because the prototype does not implement it:**
authentication should be driven by *issuer* country, not merchant country. A US OTA
sells to EEA and UK-issued cards constantly, and those are subject to PSD2 SCA
regardless of where we are established. The correct production behaviour is per-payment
`authentication_type` selected on issuer BIN country. Deferred, not overlooked.

---

## Idempotency

### D-009 · Double-charge prevention across four mutation points · 2026-08-05

**Chose:** create-intent, confirm, capture and refund all guarded.
**Rejected:** guarding checkout only.
**Why:** The checkout double-click is the obvious case but not the expensive one. An
operations agent double-clicking Refund moves real money twice, and the ticketing
worker retrying a capture is more probable than a traveller double-clicking Pay. The
guard is one pattern applied four times, so the marginal cost of full coverage is
small.

### D-010 · Identity is derived, and enforced by the database · 2026-08-05

**Chose:** `hs_payment_id = 'pay_' + payments.id` (ULID), giving exactly the 30
characters Hyperswitch requires; guarded by a partial unique index on
`payments (booking_id, kind)` and a length check constraint.
**Rejected:** a generic Stripe-style idempotency middleware across all routes.
**Why:** Hyperswitch already makes payment creation idempotent when supplied a
`payment_id`, so a full middleware layer would duplicate it. Deriving identity from the
database row makes the guard a constraint rather than application logic, which cannot
be bypassed by a code path that forgets to call the wrapper.

Response replay was retained from the middleware approach for create-intent only,
because a double-click there must return the *same* `client_secret` — a conflict
response would render an error underneath a working payment form. For capture and
refund the correct answer to a duplicate is "already done", not a replay.

### D-011 · Ambiguous outcomes resolve by reading, never by retrying · 2026-08-05

**Chose:** on timeout or unknown response, read payment state back with
`GET /payments/{id}` before deciding.
**Rejected:** optimistic retry with backoff.
**Why:** A capture that times out may or may not have moved funds. Retrying it is
precisely how a double-capture happens. The same reasoning applies to refunds.

### D-013 · `withIdempotency` releases a key only when `fn()` itself throws, and that is a contract on `fn`, not a proven invariant · 2026-08-06

**Chose:** in `lib/idempotency.ts`, `fn()` runs inside its own try/catch. If `fn()`
throws, the key is released so a retry can attempt `fn()` again. If `fn()` succeeds but
the follow-up bookkeeping `UPDATE` (marking the record `complete` and storing the
response) then fails, the key is left `in_flight` and the error propagates —
**never** deleted or reset.
**Rejected:** a single try/catch around both `fn()` and the bookkeeping update, which
deletes the key in the catch regardless of which of the two failed.
**Why:** If `fn()` created a real Hyperswitch payment and only the bookkeeping write
then failed, deleting the key would make the next retry look identical to a fresh
request: the retry would find no row, run `fn()` again, and create a second payment.
That is the exact double charge this function exists to prevent. Per D-011, a caller
that observes a bookkeeping-failure error (or later finds the record stuck `in_flight`)
resolves it by reading state back — e.g. `GET /payments/{id}` — never by re-invoking
`withIdempotency` with the assumption that the previous attempt didn't happen.

**What this module actually guarantees, precisely — corrected 2026-08-06 after
review:** an earlier version of this entry said a released key "only ever means `fn()`
is known not to have produced a lasting side effect." That overstates it.
`withIdempotency` guarantees exactly one thing: *the key is released if and only if
`fn()` threw.* Whether a throw from `fn()` actually means nothing durable happened is
a property of `fn`, not of this function — `withIdempotency` cannot see inside `fn()`
and has no way to verify it.

**This makes it a contract on every `fn` passed in, and Tasks 10+ must satisfy it**:
if `fn` performs a remote mutation whose outcome can be ambiguous on failure — a
Hyperswitch call that times out or returns an unparsable body after the payment may
already have been created, exactly the scenario D-011 exists for — `fn` must resolve
that ambiguity itself before throwing: read state back (`GET /payments/{id}`) and
either return the real result normally, or throw only once it has confirmed nothing
durable was created. A `fn` that throws on ambiguous failure without doing this
reintroduces the double charge this module exists to prevent, just one layer up: the
key is released (correctly, per this module's actual guarantee), the caller retries,
and `fn` runs again against a payment that already exists. Documented prominently in
`withIdempotency`'s JSDoc in `lib/idempotency.ts`, not only here, since whoever wires
the first real Hyperswitch call into `fn` needs to see it at the call site.

**Not built:** a caller-signalled "ambiguous, don't release" flag that would let `fn`
report "I don't know what happened" as a third outcome distinct from success/throw,
handled by leaving the key `in_flight` instead of requiring `fn` to resolve the
ambiguity before returning control. Deferred rather than speculatively built — nothing
currently needs it, and the contract above is sufficient as long as every `fn` honors
it. If Task 10 (or later) finds the read-back-before-throw obligation awkward to
satisfy inside a given `fn`, that is the moment to revisit this, not before.

**Judgement call beyond the stated correction:** between `onConflictDoNothing()` and
the follow-up `SELECT`, a concurrent request's failed attempt can delete the row first,
so the `SELECT` finds nothing. Rather than throwing on the missing row, the claim loop
treats this as "the key is free again" and retries the insert, bounded at 5 attempts
before giving up loudly (`IdempotencyClaimExhaustedError`). This is safe under the same
contract described above: a deleted row means the concurrent `fn()` that held it
threw, and per the contract every `fn` must guarantee a throw means nothing durable was
created — so there is nothing to double-run by reclaiming the key. Verified with a
real-DB test that forces this exact race (`tests/integration/idempotency.test.ts`,
"never releases the key when fn() succeeds but the bookkeeping update fails, so a
retry does not re-run fn()").

### D-014 · A retry-created second Hyperswitch payment is an accepted residual risk, not fixed with deterministic id derivation · 2026-08-06

**Chose:** accept that a retried `createBooking` can, in two narrow cases, create a
second Hyperswitch payment for the same booking attempt; rely on `capture_method:
manual` (D-002) to bound the consequence to a stray, uncaptured authorization that
expires on its own, never a double charge.

**The two cases, both inside `lib/bookings/create.ts`'s `fn`:**

1. **Bookkeeping failure after a real create.** `createIntent` succeeds, then our own
   `db.insert(payments)` fails. `fn()` throws, `withIdempotency` releases the key (by
   design — see D-013), and a retry runs `fn()` again. `fn()` generates a fresh
   `payments.id` (and therefore a fresh `hs_payment_id`) on every invocation, so the
   retry creates a *second* Hyperswitch payment; the first is orphaned.
2. **`createIntent` fails ambiguously and the read-back (task-10 correction 1) cannot
   confirm either way.** `createIntentOrReadBack` in `lib/bookings/create.ts` reads
   `getPayment(hsPaymentId)` back before rethrowing. If that read-back itself fails —
   a second, independent transport failure — there is no way to tell whether the
   original `createIntent` call actually landed. The current `fn()` must still resolve
   to either a success or a throw; there is no third outcome. It rethrows the original
   error, which releases the key exactly as in case 1, and a retry can again create a
   second payment under a fresh `hs_payment_id`.

**Case 2's bound is the same as case 1's, and strictly better in the common case.**
Each `createBooking` attempt calls `createIntentOrReadBack` — and therefore
`createIntent` — exactly once. So a single retry adds *at most one* additional
orphaned authorization, the identical worst-case bound as case 1's "one bookkeeping
failure, one extra payment." It is not worse merely because two independent failures
were involved instead of one. And unlike case 1, case 2's worst case is not the
typical case: most of the time the read-back's own failure means `createIntent`'s
underlying request never landed either (the same network path just broke twice), so
the common outcome is zero orphaned authorizations, not one. Repeated retries against
a persistently broken read-back path would still add at most one orphan per attempt,
not one that compounds within a single attempt — there is no loop inside `fn()` that
could multiply it.

**The blast radius is slightly wider than "a second payment," worth stating precisely
rather than understating:** `bookingId`, like `paymentId`, is generated fresh inside
`fn()` on every invocation. A retry does not reuse the first attempt's booking row — it
inserts a brand-new one. So the first attempt's booking is left behind in `QUOTED`
permanently, with **no payment row linked to it at all** (case 1: the insert that would
have linked it is exactly what failed), while the stray Hyperswitch authorization it
caused sits unlinked to any row in our database — findable only via the Hyperswitch
dashboard, not our own ops console. This is clutter, not a money-safety issue: D-002
still guarantees the authorization itself is never captured and expires. But it means
the ops console will show an abandoned `QUOTED` booking with no explanation, and that is
worth a demo-day note if one of these ever surfaces, rather than looking like a bug in
the ops view.

**Rejected:** deriving `hs_payment_id` deterministically from the idempotency key (so a
retry reuses the same id and Hyperswitch's own idempotency, per D-010, dedupes it
server-side).
**Why:** Both cases are narrow — a bookkeeping `INSERT` failing immediately after a
successful network call, or two independent transport failures on the same attempt —
and, critically, **neither can produce a double charge**. Every flight authorization is
`capture_method: manual` (D-002): an orphaned authorization is never captured, so it
simply expires and drops off the traveller's card. The outcome is a stray hold, not
lost money. Building deterministic id derivation to close a risk whose worst case is
"an authorization we never charge, that expires on its own" is not proportionate to
what it would cost: it would mean plumbing the idempotency key (not the database-issued
ULID) through to `toHsPaymentId`, changing the 30-character derivation D-010 already
verified, and re-deriving it identically on every retry path — for a failure mode that
is already self-healing.

**What would fix it in production:** derive `hs_payment_id` deterministically from the
idempotency key rather than from a freshly generated `payments.id`, so a retry
(whichever of the two cases triggered it) reuses the same `hs_payment_id` and
Hyperswitch's server-side idempotency on `payment_id` (D-010) dedupes it — collapsing
both cases to "the retry sees the same payment," the same guarantee create-intent
already has on a clean double-submit.

**Not built:** the tri-state "ambiguous, don't release" signal into `withIdempotency`
that D-013 explicitly deferred pending a call site that found the throw-means-nothing-
durable-happened obligation genuinely awkward. Case 2 above is that call site, and it
was evaluated rather than silently worked around: extending `withIdempotency` to let
`fn` say "I don't know, leave the key in_flight" would fully close case 2, but not case
1 (a real success followed by a real, unrelated bookkeeping failure — there is nothing
ambiguous about that one; `fn` succeeded and then something else broke). Since case 1
requires accepting this residual risk regardless, and D-002 already bounds its
consequence to a self-expiring hold, adding machinery to `withIdempotency` for case 2
alone was judged not worth it — the same accepted-risk reasoning covers both.

---

## Verification

What was confirmed against the live hosted sandbox, rather than assumed from docs.

### V-001 · Manual capture, partial capture, void and decline · 2026-08-06

Run: `npx tsx -r dotenv/config scripts/smoke.ts`. Connector: **`authorizedotnet`**.
Profile `pro_LjnPawtO6EjxyUbjKCzA`.

| Probe | Sent | Result |
| --- | --- | --- |
| Authorize, no charge | $654.00, `capture_method: manual`, `no_three_ds` | `requires_capture`, `amount_capturable: 65400` |
| Partial capture | `amount_to_capture: 60000` | `partially_captured`, `amount_received: 60000` |
| Void an authorization | `POST /payments/{id}/cancel` | `cancelled` |
| Decline | billing zip `46282` | `failed`, `error_code: 2`, "This transaction has been declined." |
| Routing, low amount | $29.00 | routed to `fauxpay`, `succeeded` |
| Routing, flight amount | $654.00 | routed to `authorizedotnet` |

This clears the assumption the whole architecture rests on: **the OTA can hold funds
without charging, then capture only once a ticket exists, and release them at no cost if
it does not.** D-002, D-003 and D-004 are all downstream of it. Had capture returned
`NotImplemented`, the spec would have needed rewriting rather than implementing.

Two notes for whoever runs this next:

- The decline is triggered by **billing ZIP 46282**, per Authorize.net's testing guide.
  Their amount-based triggers ($70.02 and similar) are marked deprecated — "may cease to
  function without notice" — so they are not used here. The ZIP trigger also keeps the
  fare realistic at $654 instead of $0.02, which matters when demoing.
- Stripe decline cards do nothing on Authorize.net. `4000000000000002` authorizes
  normally. A decline test that silently approves is worse than no decline test.

### V-002 · `GET /payments/{id}` returns the same `client_secret` post-create, for an unconfirmed payment · 2026-08-08

Verified against the live sandbox: created an unconfirmed payment (`confirm: false`,
the state every flight intent is in immediately after `createIntent`), then
`GET /payments/{id}` on it. **The `client_secret` in the read-back response is
identical to the one returned by the original create.**

This is what makes the read-back path in `createIntentOrReadBack`
(`lib/bookings/create.ts`, task-10 correction 1) safe to return directly: on an
ambiguous `createIntent` failure, the function returns whatever `getPayment`
reports, including `intent.client_secret!`. Before this check, that `!` was an
unverified assumption — exactly the kind of guess the project rules forbid ("If you
cannot verify an endpoint or field, say so instead of guessing"). It is now a
confirmed fact rather than an assumption: a traveller who hits this path gets the
correct client secret and can complete checkout normally, not a stale or missing one.

---

## Deferred, with reasoning

Not built, and why. Each would be dishonest to demo given sandbox constraints.

| Item | Reason deferred | How we would approach it |
| --- | --- | --- |
| Disputes and chargebacks | Cannot manufacture a real chargeback lifecycle in sandbox | Dispute webhooks; billing descriptor strategy so `TRIPCO*` is recognisable; compelling evidence assembled from itinerary, IP, and check-in record. Travel has the worst CNP dispute profile of any vertical. |
| Fraud screening (FRM) | Needs a Signifyd / Riskified merchant account | Hyperswitch FRM workflow, pre-authorization. Travel is a top card-testing target: high value, instantly resellable, same-day departures leave no review window. |
| BNPL — Affirm, Klarna, Uplift | All require merchant onboarding; a connector existing in config is not the same as being able to transact | Affirm connector exists in `sandbox.toml` and needs a real public/private key pair. Material for travel — a $900 fare is a financeable purchase, and Uplift is travel-specific. |
| Apple Pay | Needs verified domain, hosted association file, Apple device, supported region | Google Pay covers the wallet story at a fraction of the setup cost. |
| Incremental authorization | Implemented in Hyperswitch only for Stripe, PayPal, Cybersource, Wells Fargo, Archipel; Stripe's own API gates it largely to card-present | Fare increase between quote and issuance handled by void plus re-authorization at the new amount with fresh consent. |
| Extended authorization | Manual trigger supported only for Adyen and PayPal | Relevant when a hold outlives the ~5–7 day authorization lifetime; otherwise void and re-authorize against the stored payment method. |
| `manual_multiple` partial capture | Connector-gated, and rejected outright by the dummy connector | Split-ticket carts where one PNR issues and another fails; alternative is one intent per PNR under a shared order id. |
| Multi-currency and FX | No FX in sandbox | Fares display in USD while carriers settle in their own currency; the exposure sits with the OTA. |
| BSP/ARC airline settlement | Entirely off-Hyperswitch | The substantive merchant-of-record complexity: we collect, the carrier is paid through IATA BSP or ARC settlement, or via a virtual card for agency-pay bookings. |
| Split settlement | Needs real connected accounts | Relevant only if we move to marketplace-of-record for hotels or ancillaries. Stripe Connect / Adyen for Platforms / Xendit. |
| Payouts | Needs a payout connector relationship | Traveller compensation and voucher cash-out — distinct from refunds. |
| Three-way reconciliation | No settlement data in sandbox | Hyperswitch payments, PSP settlement, and BSP/ARC airline settlement must agree. |
