# DECISIONS

Every payment behaviour decision: what we chose, what we rejected, why.

Newest first within each section. Dates are the date the decision was taken.

---

## Environment and credentials

### D-001 · Stripe test-mode connector is in scope · 2026-08-05

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

**Chose:** rule-based routing on amount — under $50 to `fauxpay`, everything else to
Stripe.
**Rejected:** routing on `capture_method`; a blind primary/fallback pair.
**Why:** `capture_method` is not an available routing dimension (documented dimensions
are payment method, payment method type, amount, currency, country, card type, card
network), so the intuitive rule is not expressible. Amount cleanly separates the two
products, which do not overlap in price.

Business justification rather than demo contrivance: trip protection is underwritten by
a third party, not the OTA, and settling it through a separate processor reflects the
real commercial arrangement.

### D-006 · The dummy connector is excluded from default fallback · 2026-08-05

**Chose:** Default Fallback Routing lists Stripe only.
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
