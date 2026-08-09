# SCHEMA

Neon Postgres. Amounts are integers in minor units throughout — never floats. A USD
fare of $654.00 is `65400`.

Last updated: 2026-08-05, for `FEATURE_booking_payments.md`.

---

## Enums

```sql
CREATE TYPE booking_state AS ENUM (
  'QUOTED',
  'PAYMENT_FAILED',
  'AUTHORIZED',
  'TICKETING',
  'TICKETED',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED'
);

CREATE TYPE payment_kind AS ENUM ('flight', 'protection', 'ancillary');

CREATE TYPE idempotency_status AS ENUM ('in_flight', 'complete');
```

`payments.state` deliberately uses `text` rather than an enum: it mirrors Hyperswitch's
intent status vocabulary, which is longer than we model and may gain values. Storing it
loosely avoids a migration every time Hyperswitch adds a status.

---

## bookings

The domain object. Sole writer is `lib/bookings.ts`.

```sql
CREATE TABLE bookings (
  id                TEXT PRIMARY KEY,              -- ULID, 26 chars
  pnr               TEXT NOT NULL UNIQUE,
  itinerary_id      TEXT NOT NULL,
  passengers        JSONB NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'USD',
  amount_minor      BIGINT NOT NULL CHECK (amount_minor > 0),
  state             booking_state NOT NULL DEFAULT 'QUOTED',
  customer_id       TEXT,                          -- Hyperswitch customer id
  payment_method_id TEXT,                          -- from flight CIT, enables MIT
  ticket_number     TEXT,
  void_deadline_at  TIMESTAMPTZ,                   -- DOT 24h boundary, server-computed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bookings_state_idx      ON bookings (state);
CREATE INDEX bookings_created_at_idx ON bookings (created_at DESC);
```

`ticket_number` is non-null only in `TICKETED` and its refund successor states. That is
invariant 1 from the spec — capture never precedes issuance — made visible in the data.

---

## payments

One row per Hyperswitch PaymentIntent. A booking has up to three kinds.

```sql
CREATE TABLE payments (
  id             TEXT PRIMARY KEY,                 -- ULID, 26 chars
  booking_id     TEXT NOT NULL REFERENCES bookings(id),
  kind           payment_kind NOT NULL,
  hs_payment_id  TEXT NOT NULL UNIQUE,             -- 'pay_' + id, exactly 30 chars
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  capture_method TEXT NOT NULL,                    -- 'manual' | 'automatic'
  connector      TEXT,                             -- populated from auth response
  state          TEXT NOT NULL,                    -- mirrors Hyperswitch intent status
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT hs_payment_id_is_30_chars CHECK (length(hs_payment_id) = 30)
);

-- The double-charge guard. Partial: a booking may carry several ancillary
-- charges, but exactly one flight payment and one protection payment.
CREATE UNIQUE INDEX payments_one_per_kind_idx
  ON payments (booking_id, kind)
  WHERE kind IN ('flight', 'protection');

CREATE INDEX payments_booking_id_idx ON payments (booking_id);
```

The `length(hs_payment_id) = 30` check enforces Hyperswitch's `minLength: 30,
maxLength: 30` at the database rather than trusting application code. `'pay_'` (4) plus
a ULID (26) is exactly 30.

`connector` is written from the authorization response and read by the capability
guardrail — a `flight` payment on a connector without capture support is voided
immediately.

---

## refunds

```sql
CREATE TABLE refunds (
  id            TEXT PRIMARY KEY,                  -- ULID
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  hs_refund_id  TEXT UNIQUE,                       -- null until Hyperswitch responds
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  reason        TEXT NOT NULL,
  state         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refund idempotency guard.
CREATE UNIQUE INDEX refunds_one_per_reason_idx ON refunds (payment_id, reason);

CREATE INDEX refunds_payment_id_idx ON refunds (payment_id);
```

`hs_refund_id` is nullable because the row is inserted before the Hyperswitch call, so
the unique constraint on `(payment_id, reason)` blocks a concurrent duplicate. See the
open question in the spec: if Hyperswitch accepts a merchant-supplied refund id, this
becomes belt-and-braces rather than the sole guard.

---

## booking_events

Append-only. Never updated, never deleted. Drives the ops timeline.

```sql
CREATE TABLE booking_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX booking_events_booking_id_idx ON booking_events (booking_id, created_at);
```

Event types: `booking.created`, `payment.authorized`, `payment.declined`,
`payment.retried`, `ticketing.attempted`, `ticketing.succeeded`, `ticketing.failed`,
`payment.captured`, `payment.voided`, `payment.void_failed`, `refund.created`,
`protection.added`, `webhook.received`, `idempotent.replay`, `capability.violation`.

`payment.void_failed` records a void attempt whose Hyperswitch call failed. It is
written after the surrounding transaction has rolled back (the failure aborts the
transaction, so a record written inside it would vanish — and a pool-connection
write while the transaction still held the booking row `FOR UPDATE` would
self-deadlock on the FK's KEY SHARE lock).

`idempotent.replay` and `capability.violation` exist so the guards are observable rather
than silent — a duplicate that is correctly swallowed should still leave a trace.

`capability.violation` (emitted by the webhook handler, Task 12 / D-007) carries
`{ connector, kind, reason, missing, voided, voidError? }`: `connector` and `kind` are
the values `assertCapableOrThrow` was called with, `reason` is that call's thrown
message (human-readable), `missing` is the structured `(keyof Capability)[]` read off
`ConnectorCapabilityError.missing` (not parsed back out of `reason`, which carries no
stability contract), `voided` records whether this delivery actually called
`voidPayment` successfully, and `voidError` (present only when a void was attempted and
failed — network error, 5xx, timeout) carries that failure's message. `voided: false`
therefore has two distinct causes, both readable from the same row: the payment was
already in a terminal state (a duplicate delivery, `voidError` absent), or a void was
attempted and the Hyperswitch call itself failed (`voidError` present).

---

## idempotency_records

Response replay for create-intent, and the caller-key path for ancillary charges.

```sql
CREATE TABLE idempotency_records (
  key                  TEXT PRIMARY KEY,
  endpoint             TEXT NOT NULL,
  request_fingerprint  TEXT NOT NULL,              -- hash of the normalized body
  response             JSONB,                      -- null while in_flight
  status               idempotency_status NOT NULL DEFAULT 'in_flight',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_created_at_idx ON idempotency_records (created_at);
```

`request_fingerprint` guards against key reuse with a different body — same key,
different payload is a client bug and returns an error rather than the wrong cached
response.

A row stuck in `in_flight` means a request died mid-flight. Those resolve by reading
payment state back from Hyperswitch, per the error-handling rule that ambiguity is
resolved by reading, never by retrying.

---

## Notes

- Every state transition runs inside a transaction with `SELECT ... FOR UPDATE` on the
  `bookings` row. That row lock is what makes the capture and refund guards correct
  under concurrency.
- `updated_at` maintained by trigger on `bookings`, `payments`, `refunds`.
- No table stores card data, a PAN, or a Hyperswitch API key. The vault is
  Hyperswitch's; we store only `customer_id` and `payment_method_id` references.
