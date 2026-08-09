# Flight OTA on Hyperswitch — prototype

A US online travel agency selling flights, built on the [Hyperswitch](https://hyperswitch.io)
hosted sandbox. We are **merchant of record**: the traveler pays us, we settle with the
airline separately. The payment problem that makes flights interesting: money is
**authorized at checkout but captured only after the airline actually issues a ticket** —
a seat that never materializes must never be paid for.

## Architecture in one paragraph

Next.js (App Router) on top of a Neon Postgres database (Drizzle ORM), talking
server-side to the Hyperswitch sandbox API. A booking moves through an explicit state
machine (`QUOTED → AUTHORIZED → TICKETING → TICKETED`, with `VOIDED`, `REFUNDED`,
`PARTIALLY_REFUNDED` branches — `lib/state-machine.ts`); every money mutation is guarded
by database-backed idempotency (`lib/idempotency.ts`) and by identifiers we mint
ourselves (`hs_payment_id`, `refund_id`) so retries can always read state back instead of
mutating twice. A static connector-capability table (`lib/connector-capabilities.ts`)
refuses to let a payment proceed on a connector that can't capture/void/MIT what that
payment will later need. Every payment-behaviour decision is recorded in
[DECISIONS.md](DECISIONS.md); the schema of record is [SCHEMA.md](SCHEMA.md); the product
spec is [FEATURE_booking_payments.md](FEATURE_booking_payments.md).

## Setup from a cold start

1. **Hyperswitch sandbox account** — [app.hyperswitch.io](https://app.hyperswitch.io)
   (hosted sandbox only; publishable keys start with `pk_snd_`).
2. **Authorize.net sandbox account** — [developer.authorize.net](https://developer.authorize.net).
   *Not Stripe*: Hyperswitch's Stripe connector sends raw card data on the secret-key
   path and Stripe blocks that without full business verification — see D-012 in
   DECISIONS.md.
3. In the Hyperswitch Control Center, connect **`authorizedotnet`** (with the
   Authorize.net sandbox credentials) and **`fauxpay`** (the dummy connector, no
   credentials needed).
4. Add the routing rule: **`amount < 5000` (minor units, i.e. $50) → `fauxpay`,
   everything else → `authorizedotnet`**. This is what makes the $24 trip-protection
   charge safe (D-005, D-022) and keeps real flight money on the capture-capable
   connector.
5. Create a [Neon](https://neon.tech) Postgres database.
6. `.env` at the repo root (server-side only — nothing secret ever reaches the browser):

   ```
   HYPERSWITCH_API_KEY=snd_...
   HYPERSWITCH_PUBLISHABLE_KEY=pk_snd_...
   HYPERSWITCH_PROFILE_ID=pro_...
   HYPERSWITCH_WEBHOOK_SECRET=...
   DATABASE_URL=postgresql://...
   APP_BASE_URL=http://localhost:3000
   ```

7. `npm install`, then `npm run db:migrate` to apply the migrations in `drizzle/`.

## Smoke test

```
npm run smoke
```

Proves, against the live sandbox: manual authorization lands on `authorizedotnet` as
`requires_capture`; partial capture works; authorize-then-void works (the DOT
24-hour path); and the decline trigger produces a failed payment, not a transport
error. If the connector comes back as anything but `authorizedotnet`, routing is
misconfigured — fix that before demoing anything.

## Demo script

```
npm run seed     # demo day only — fauxpay payments expire after ~2 days
npm run dev
```

1. **Book** — pick an itinerary on `/`, name the traveller, continue to payment.
2. **Checkout** — pay with the test card (below); optionally tick trip protection
   ($24, lands on the dummy connector). The card is *authorized*, not charged.
3. **Issue** — open `/ops`, click **Issue ticket**: the booking becomes `TICKETED`
   and only then is the card captured. Book `itin_bos_sea` to watch issuance fail
   terminally and the authorization get voided instead — the traveller pays nothing.
4. **Cancel or refund** — **Cancel** (within 24h, a void) on an `AUTHORIZED` booking;
   **Refund** (partial or full) on a `TICKETED` one.
5. **Ops console** — `/ops` shows every booking with stored vs. **live** payment
   state side by side; divergence is highlighted, not auto-repaired (D-011).

### Test cards

| Purpose | Value |
| --- | --- |
| Success | `4242424242424242`, any future expiry, any CVC |
| Decline | Billing ZIP **`46282`** (Authorize.net's trigger) |

Do **not** use `4000000000000002` to test declines — that's a Stripe card and
authorizes normally on Authorize.net (V-001). The ZIP-46282 decline is currently
**not reachable through the browser checkout** on this sandbox account: its
`required_fields` schema collects no billing ZIP (D-016). Demonstrate the decline
via `npm run smoke` or the API directly.

## Known simplifications

- **The GDS is simulated** (`lib/ticketing.ts`): deterministic per itinerary —
  `itin_sfo_jfk` always issues, `itin_bos_sea` always fails terminally,
  `itin_ord_lax` fails once retryably then succeeds.
- **The retryable-issuance counter is in-memory** and resets on a cold start —
  serverless-unsafe by design, documented in `lib/ticketing.ts` itself.
- **`/ops` has no authentication.** Anyone with the URL can issue, cancel, refund.
- **The browser-driven decline demo is unavailable** on this sandbox account
  (D-016); declines are proven via the API/smoke script instead.
- **MIT/off-session charging (flow H)** depends on Authorize.net capability that is
  source-verified but not yet live-tested (`lib/connector-capabilities.ts`; the
  first live test will be recorded as a new V-entry in DECISIONS.md).

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the 3-page architecture and decisions doc
- [FEATURE_booking_payments.md](FEATURE_booking_payments.md) — product spec: flows, state machine, invariants
- [SCHEMA.md](SCHEMA.md) — schema of record
- [DECISIONS.md](DECISIONS.md) — every payment-behaviour decision (D-001…D-024) and live verification log (V-001…V-005)
