# FEATURE: Booking Payments

Flight OTA prototype — payment architecture for the booking, ticketing, cancellation
and post-booking charge flows on the Hyperswitch hosted sandbox.

Status: spec, pending approval. No code written.

---

## 1. Context

US online travel agency selling flights. We are merchant of record: the traveller pays
us, we settle with the airline separately.

The defining property of the vertical is that **payment and fulfilment are separated in
time and fulfilment can fail**. When a traveller checks out we do not yet own the seat.
The seat is owned once the PNR is ticketed against the carrier, which happens after
checkout and which can fail. Every payment decision below follows from that.

## 2. Scope

### Built

| | Flow | Why it is in scope |
| --- | --- | --- |
| A | Book and authorize | Core. Establishes the hold. |
| B | Card decline, then traveller retries with another card | Highest-frequency real failure at OTA checkout. |
| C | Ticket issued, then capture | The payment/fulfilment join. |
| D | Ticketing fails, then void | Proves the traveller is never charged for a seat we could not get. |
| E | DOT 24-hour cancellation, void | US regulatory requirement, and the strongest argument for manual capture. |
| F | Schedule change, partial refund | Involuntary refunds are routine in travel. |
| G | Trip protection add-on, auto-capture, second connector | Demonstrates capability-aware routing. |
| H | Post-booking bag fee, off-session MIT | Second integration model; the flow that makes an OTA sticky. |

### Deferred, with reasoning

Deferred items are recorded in full in `DECISIONS.md`. Summary: disputes and
chargebacks, FRM, BNPL (Affirm / Klarna / Uplift), Apple Pay, multi-currency and FX,
BSP/ARC airline settlement, split settlement, payouts, three-way reconciliation,
incremental authorization, extended authorization, and `manual_multiple` partial
capture for split-ticket carts.

Each is deferred for one of three reasons: it needs a live merchant relationship we
cannot obtain in three days, it needs a connector capability absent from the sandbox,
or it is off-Hyperswitch infrastructure entirely.

## 3. Architecture

Next.js App Router on Vercel, TypeScript, Neon Postgres.

### Units

**`lib/hyperswitch.ts`** — sole module that talks to `sandbox.hyperswitch.io`.
Server-only (`import 'server-only'`). API key read from env, never bundled. Exposes
only the verbs used: `createIntent`, `capture`, `voidPayment`, `refund`,
`chargeOffSession`, `getPayment`. Containing the wire format here keeps the v1/v2 API
split from leaking through the app.

**`lib/bookings.ts`** — the domain. Owns the state machine. Sole writer to `bookings`.
Every transition runs inside a transaction with `SELECT ... FOR UPDATE` on the booking
row.

**`lib/ticketing.ts`** — simulated GDS. Deterministic, keyed off itinerary id, so one
designated itinerary always fails issuance and the void path is reproducible on demand.
Returns a ticket number or a typed failure classified retryable / terminal.

**`lib/connector-capabilities.ts`** — static capability table. See §6.

**Route handlers** — thin: parse, delegate, serialize. No business logic.

```
POST /api/bookings                    create booking + flight intent (manual capture)
POST /api/bookings/[id]/protection    trip-protection intent (auto capture)
POST /api/bookings/[id]/issue         run ticketing, then capture or void
POST /api/bookings/[id]/cancel        DOT 24h void
POST /api/bookings/[id]/refund        full or partial refund
POST /api/bookings/[id]/ancillary     off-session MIT charge
POST /api/webhooks/hyperswitch        HMAC-verified, advances payment state
```

**Ops console** at `/ops` — lists bookings with stored state beside a live
`GET /payments` read, flags divergence, and carries the Issue / Cancel / Refund
actions. Ticketing is operator-triggered rather than scheduled: Vercel Cron intervals
are too coarse to demonstrate a hold, and a live demo that depends on a scheduler
firing on cue is a demo that fails on cue.

### Boundaries

The app never infers booking state from payment state. `payments.state` mirrors
Hyperswitch; `bookings.state` is ours. Separate columns, separate writers.

## 4. Data model

Full DDL in `SCHEMA.md`. Five tables: `bookings`, `payments`, `refunds`,
`booking_events`, `idempotency_records`.

A booking has up to three payments (`flight`, `protection`, `ancillary`), hence the
separate table.

`booking_events` is append-only and drives both the ops timeline and the demo
narrative.

### State machine

| From | Event | To |
| --- | --- | --- |
| `QUOTED` | authorization succeeded | `AUTHORIZED` |
| `QUOTED` | authorization declined | `PAYMENT_FAILED` |
| `PAYMENT_FAILED` | traveller retries, same intent reused | `QUOTED` |
| `AUTHORIZED` | issuance started | `TICKETING` |
| `AUTHORIZED` | cancelled within DOT 24h window | `VOIDED` |
| `TICKETING` | ticket issued, then captured | `TICKETED` |
| `TICKETING` | retryable failure (GDS timeout) | `TICKETING` |
| `TICKETING` | terminal failure, authorization voided | `VOIDED` |
| `TICKETED` | full refund | `REFUNDED` |
| `TICKETED` | partial refund | `PARTIALLY_REFUNDED` |
| `PARTIALLY_REFUNDED` | remaining amount refunded | `REFUNDED` |

Terminal states: `VOIDED`, `REFUNDED`. `PARTIALLY_REFUNDED` is not terminal — a
schedule change affecting one passenger can be followed by a full cancellation.

`TICKETING` holds funds. A booking sitting in `TICKETING` has an authorized,
uncaptured payment and no ticket, which is the only state where our money position and
the traveller's expectation genuinely diverge — so it is the state the ops console
surfaces most prominently.

### Invariants

1. **Capture never precedes ticket issuance.** A booking reaches `TICKETED` only when
   a ticket number exists and the payment is captured, in that order. If issuance
   fails terminally we void.
2. **Payment state is not booking state.** A webhook may move a payment to `succeeded`
   without moving a booking to `TICKETED`.
3. **A flight payment only ever sits on a connector that can capture and void.**
   Enforced at runtime, see §6.

## 5. Idempotency

Four mutation points, one pattern: deterministic identity, a database constraint, and
reuse rather than recreate.

| Point | Mechanism | Behaviour on duplicate |
| --- | --- | --- |
| Create intent | Deterministic `hs_payment_id` + unique constraints + stored response replay | Returns the same `client_secret` |
| Confirm (Pay click) | Client in-flight lock; Hyperswitch rejects confirm on a non-`requires_confirmation` intent | Second click no-ops |
| Capture | `SELECT FOR UPDATE`; booking must be `AUTHORIZED` | No-op, logged as event |
| Refund | Unique constraint on `(payment_id, reason)` + state guard | No-op, returns original refund |

### Identity derivation

Hyperswitch's `payment_id` is **exactly 30 characters** (`minLength: 30,
maxLength: 30`) and, when supplied, makes payment creation idempotent server-side. A
ULID is 26 characters of Crockford base32, so:

```
hs_payment_id = 'pay_' + payments.id     // 4 + 26 = 30 exactly
```

Each `payments` row gets a ULID at insert; the Hyperswitch id derives from it. Identity
is therefore decided by the database, and the guard is the unique constraint on
`payments (booking_id, kind)` — partial, `WHERE kind IN ('flight','protection')`,
because a booking may legitimately carry several ancillary charges. Ancillary calls
supply an explicit caller key routed through `idempotency_records`.

Response replay applies to create-intent only. A double-click there must return the
same `client_secret` so the second click is invisible; returning a conflict would
render an error under a working payment form. For capture and refund the correct answer
to a duplicate is "already done", not a replay.

### Relationship to the decline-retry flow

A declined attempt leaves the intent reusable. "Try another card" reuses the same
`hs_payment_id`, so Hyperswitch records attempt #2 under the same PaymentIntent and the
Control Center shows one booking with a multi-attempt timeline. Retry and double-charge
prevention are the same mechanism, not two.

## 6. Hyperswitch configuration

One merchant account, one business profile (`ota_us`). `profile_id` is passed
explicitly on every create; leaving it implicit produces "no eligible connector",
which presents as a routing bug.

### Connectors

| Connector | Mode | Role | Capture | Void | MIT | Webhooks |
| --- | --- | --- | --- | --- | --- | --- |
| `authorizedotnet` | sandbox | Flight bookings | yes | yes | yes¹ | yes¹ |
| `fauxpay` | dummy | Trip protection | **no** | **no** | **no** | **no** |
| `stripe` | test (`sk_test_`) | not used — see D-012 | yes² | yes² | yes² | yes² |

¹ Capture and void are verified live against the sandbox (V-001, `DECISIONS.md`). MIT
and webhooks are established from connector source only — credible, but no MIT payment
or webhook has actually been exercised yet.

² Stripe's capability is what it can do in principle, not what we can reach. D-012
found Hyperswitch's Stripe connector sends the raw PAN on the secret-key path, which
Stripe blocks by default; lifting the block needs full business activation, which the
project rules place on the deferred list. This is a credentialing problem, not a
capability one — Stripe stays connected but unused so the finding stays reproducible.

The dummy connector's limits are verified from source
(`crates/hyperswitch_connectors/src/connectors/dummyconnector.rs`): capture returns
`NotImplemented`, void is an empty impl, `SetupMandate` is explicitly unimplemented,
webhooks return `WebhooksNotImplemented`, and `manual_multiple` / `scheduled` capture
are rejected in `validate_connector_against_payment_request`. Dummy payments also
expire after two days. `fauxpay`, `phonypay` and `pretendpay` are all instances of this
same dummy connector.

### Routing

`capture_method` is **not** a rule-based routing dimension. Documented dimensions are
payment method, payment method type, amount, currency, country, card type and card
network. The rule therefore keys on amount:

```
Rule 1:  amount < $50.00   →  fauxpay            (trip protection)
Default Fallback           →  authorizedotnet     (everything else)
```

`fauxpay` is deliberately **excluded from Default Fallback**, so no flight
authorization can fall back onto a connector that cannot capture or void.

Business justification, not contrivance: trip protection is underwritten by a third
party rather than the OTA, and settling it through a separate processor reflects how
the product actually works.

### Capability guardrail

Rather than pinning `connector` server-side — which would make the dashboard rule
decorative — the app asserts capability after authorization. `lib/connector-capabilities.ts`
declares what each connector supports; a flight authorization that lands on a connector
lacking capture support is voided immediately and the booking fails loudly, rather than
entering a state it cannot leave.

Connector capability is treated as an enforced constraint, not an assumption.

### API defaults that must be overridden

- `authentication_type` defaults to `three_ds` on v1 create. Booking flow sets
  `no_three_ds` explicitly: US domestic OTA checkout suppresses 3DS for conversion, and
  a 3DS challenge disqualifies a payment from automatic retry handling.
- `capture_method` defaults to `automatic`. Manual is explicit on every flight intent.

### Webhooks

Configured against the stable production alias from day one, not a rotating preview
URL. HMAC-SHA512 verified against `payment_response_hash_key`. `fauxpay` emits no
connector webhooks, so trip-protection state comes from the synchronous response —
acceptable because it is auto-capture and terminal on return.

## 7. Flows

| | Flow | Mechanism |
| --- | --- | --- |
| A | Book and authorize | `POST /payments` with `capture_method: manual`, `no_three_ds`, `setup_future_usage: off_session`, `customer_id`, derived `payment_id`, `order_details[]` carrying fare and taxes. Result `requires_capture`; booking `AUTHORIZED`; `void_deadline_at = now + 24h`. |
| B | Decline then retry | Card `4000000000000002` declines. Booking `PAYMENT_FAILED`, intent reusable. Second card reuses the same `payment_id`; attempt #2 recorded under one intent. |
| C | Issue then capture | Ops "Issue ticket" → ticket number → `POST /payments/{id}/capture`. Ticket first, capture second. Booking `TICKETED`. |
| D | Issue fails then void | Designated always-fails itinerary → `POST /payments/{id}/cancel`. Traveller never charged. Booking `VOIDED`. |
| E | DOT 24h cancellation | Self-serve cancel while `AUTHORIZED` and within `void_deadline_at` → void, not refund. Free and instant, versus interchange-costing and slow. |
| F | Schedule change refund | `POST /refunds` with `amount` below captured total. Booking `PARTIALLY_REFUNDED`. |
| G | Trip protection | Separate small auto-capture intent; routing rule sends it to `fauxpay`. |
| H | Post-booking bag fee | `POST /payments` with `off_session: true` and `recurring_details.payment_method_id` from the flight CIT. Server only, no SDK. |

Flow H depends on the CIT having saved a payment method, which requires
`customer_acceptance`. The SDK sends it when the traveller ticks save-card, so
`displaySavedPaymentMethodsCheckbox` must be enabled. The prototype ticks it by default
with visible copy; the doc will note that in production, consent to store a card for
later ancillary charging is a deliberate UX decision rather than a default.

## 8. Error handling

**Unknown outcomes, not declines, are the dangerous case.** If a capture times out we
do not know whether funds moved. Every ambiguous mutation resolves by reading state
back with `GET /payments/{id}` before deciding. Never retry a capture or refund
optimistically.

**Webhooks are unordered and may duplicate.** The handler advances state monotonically
only; a late `succeeded` does not resurrect a refunded payment. Ambiguity falls back to
a read.

**Ticketing failures are classified.** Retryable (GDS timeout) keeps the booking in
`TICKETING` with funds held and allows another attempt. Terminal (fare no longer
available) voids immediately. Conflating the two either strands money or discards
recoverable bookings.

**Time is server-side.** `void_deadline_at` is computed and evaluated on the server.
Client clocks are never consulted for the DOT boundary.

**Divergence is surfaced, not hidden.** The ops console shows stored state beside a
live read and flags mismatch.

## 9. Testing

Written in this order:

1. **Live sandbox smoke test — day one, first hour, before any UI.**
   `POST /payments` with `capture_method: manual` → `/capture` → `/cancel` against the
   configured connector. The entire design rests on this working. If it fails, the
   design changes, and that must surface on day one.
2. **Unit** — state machine transitions; id derivation as a property test (always
   exactly 30 characters); connector capability assertions; DOT deadline arithmetic.
3. **Integration against a mocked Hyperswitch** — headline case is concurrent
   double-submit: two simultaneous `POST /api/bookings` must yield exactly one
   `payments` row and exactly one outbound call. Written test-first.
4. **End-to-end against sandbox** — A→C and A→D.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Manual capture unavailable on the configured connector | Smoke test first hour, day one. Highest-severity assumption in the build. |
| Dummy-connector payments expire after 2 days | Re-seed demo data on demo day; keep trip protection off the critical path. |
| Preview-URL webhook churn | Pin webhooks to the production alias from the start. |
| Minor-unit arithmetic errors | Integers throughout; assert `sum(order_details[].amount) == amount`. |
| Smart retry switching connector mid-booking | `fauxpay` excluded from fallback; capability assertion voids anything that slips through. |
| Scope creep into airline search | Itineraries are hardcoded fixtures. |

## 11. Open questions

- Whether Hyperswitch accepts a merchant-supplied refund identifier. Not verified.
  Until confirmed, refund idempotency rests on our own unique constraint and state
  guard, which is sufficient but means we cannot dedupe a refund Hyperswitch already
  accepted but whose response we lost. To verify on day one.
- Whether the hosted sandbox dashboard exposes smart-retry configuration. Not required
  by any built flow; affects only what can be shown in the dashboard walkthrough.

## 12. Database impact

New database. Five tables, no migrations against existing data. Full DDL, constraints
and indexes in `SCHEMA.md`.
