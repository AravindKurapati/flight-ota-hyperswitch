# Spec: Tasks 13–19 (issuance through end-to-end verification)

Written for a cold-start implementer (Codex) with no memory of the session that built
Tasks 1–12. Everything here is either copied from the project's own source-of-truth
documents or freshly verified against the current codebase and the live Hyperswitch
sandbox. Where something is **unverified**, that is stated explicitly — do not treat
it as settled.

**Read these four files first, in this order, before writing any code:**

1. `CLAUDE.md` — project rules. They still apply, unchanged, to every task below.
2. `FEATURE_booking_payments.md` — the product spec: flows, the state machine, the
   three invariants.
3. `SCHEMA.md` — schema of record. Tasks 13–19 touch **no new tables or columns** —
   everything they need already exists. Two small additions to its event-type list
   are called out below (Tasks 17/18).
4. `DECISIONS.md` — every payment-behaviour decision so far, D-001 through D-019.
   Read D-002, D-007, D-009 through D-014, D-018 specifically; they're load-bearing
   for this batch. **Add a new decision for every judgment call you make below**,
   starting at D-020.

Current branch state as this spec is written: `feat/booking-payments`, commit
`c8f13c7`. Tasks 1–12 complete, 97/97 tests passing with `.env` present, 66 passing +
31 skipped without it, `npx tsc --noEmit` clean. Keep both true after every task.

---

## Cross-cutting facts that don't appear in the plan document

The plan document at `docs/superpowers/plans/2026-08-05-booking-payments.md` has
draft briefs for Tasks 13–19 (search for `### Task 13:` onward). **Do not implement
those briefs as written** — they predate several corrections and one real design gap
found while preparing this spec. This document supersedes them. The facts below are
why.

### 1. The connector is `authorizedotnet`, not `stripe`

Every mock in the plan document's Tasks 13/14/15/17/18 briefs uses
`connector: 'stripe'`. Stripe was retired (D-012) — Hyperswitch's Stripe connector
sends the raw card number on the secret-key path, and Stripe blocks that without full
business verification. The capture-capable connector for this project is
**`authorizedotnet`**, confirmed live (V-001, V-003). Fix every mock.

### 2. Dynamic route `params` are async

This project is on Next.js 16.3.0. Since Next 15, `params` on both page components
and route handlers is `Promise`-typed. Every route handler in Tasks 13–19 must use
`{ params }: { params: Promise<{ id: string }> }` and `const { id } = await params;`.
The plan document's briefs use the old synchronous shape throughout.

### 3. `PaymentKind` lives in `db/schema.ts`, not `lib/connector-capabilities.ts`

The plan document's own self-review section says: *"declared in both `db/schema.ts`
(as a pg enum) and `lib/connector-capabilities.ts` (as a union) — import the union
from `connector-capabilities` and derive the enum values from it."* **This is stale.**
The actual, already-shipped implementation (Task 7) went the other direction and is
better: `db/schema.ts` exports

```typescript
export type PaymentKind = (typeof paymentKind.enumValues)[number];
```

and `lib/connector-capabilities.ts` imports it from there. Do not create a second
definition. Import `PaymentKind` from `../../db` (re-exported via `db/index.ts`).

### 4. `nextState`/`canTransition` don't guard an invalid `from` — fix this once, now

`lib/state-machine.ts` indexes `TRANSITIONS[from][event]` directly:

```typescript
export function nextState(from: BookingState, event: BookingEvent): BookingState {
  const to = TRANSITIONS[from][event];
  ...
}
```

If `from` is ever a value outside `BookingState` — a corrupted row, a future migration
bug, a typo — `TRANSITIONS[from]` is `undefined`, and `undefined[event]` throws a raw
`TypeError: Cannot read properties of undefined`, not a clean, diagnosable error. This
was flagged as a carried-forward risk back in Task 4's review and never fixed, because
no task read `booking.state` from a real database row until now. **Task 13 is the
first task that does. Fix it there, once, rather than defending against it five
separate times in Tasks 13/14/15/17/18.**

```typescript
export function nextState(from: BookingState, event: BookingEvent): BookingState {
  const transitions = TRANSITIONS[from];
  if (transitions === undefined) {
    throw new Error(`Unknown booking state: "${from}"`);
  }
  const to = transitions[event];
  if (to === undefined) {
    throw new Error(`Illegal transition: ${from} cannot handle ${event}`);
  }
  return to;
}
```

Apply the same guard to `canTransition` (return `false` for an unknown `from` rather
than throwing — its contract is a boolean, not an exception).

Add a unit test in `tests/unit/state-machine.test.ts`: `nextState('BOGUS' as BookingState, 'AUTH_SUCCEEDED')` throws a clean, named error, not a `TypeError`.

While in this file: `TRANSITIONS.PARTIALLY_REFUNDED.REFUNDED_PARTIAL` is a genuine
self-loop (a second partial refund keeps the booking `PARTIALLY_REFUNDED`) that exists
in the table but has never been tested, per Task 4's original review. Task 15 below
closes this.

### 5. `withIdempotency`'s contract on `fn` — re-read it before touching money

`lib/idempotency.ts`'s `withIdempotency` JSDoc has a section headed **"Contract on
`fn`"**. Read it in full before writing any of Tasks 13, 15, 17, 18. The one-line
version: the idempotency key is released **if and only if `fn()` throws**, which is
NOT the same as "a throw means nothing happened." If `fn` calls Hyperswitch and the
response is lost to a timeout after the mutation actually succeeded, and `fn` just
lets that propagate, the caller retries and the mutation happens *again*. This has
already caused one real bug in this codebase (Task 10, `createIntentOrReadBack`,
D-014) and the fix pattern is established: on an ambiguous failure, read the resulting
state back via `getPayment(hsPaymentId)` before deciding whether to throw.

Task 18 (ancillary charges) calls `withIdempotency` directly and needs this exact
treatment. Task 15 (refunds) currently does **not** use `withIdempotency` at all in
the plan document's draft — that's a real inconsistency, addressed below.

### 6. `flightPaymentFor` already exists — use it, don't re-query

`lib/bookings/shared.ts` (built in Task 10) already has:

```typescript
export async function flightPaymentFor(bookingId: string, tx: typeof db = db) {
  const [row] = await tx.select().from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));
  if (!row) throw new Error(`No flight payment for booking ${bookingId}`);
  return row;
}
```

The plan document's Task 13/14 briefs re-query this inline instead of calling it.
Use the existing helper.

### 7. `lib/hyperswitch.ts`'s exact current shape — extend it carefully

Current exports, verified directly from source:

```typescript
createIntent(input: CreateIntentInput): Promise<HsPayment>
getPayment(hsPaymentId: string): Promise<HsPayment>
capture(hsPaymentId: string, amountMinor: number): Promise<HsPayment>
voidPayment(hsPaymentId: string, reason: string): Promise<HsPayment>
refund(input: RefundInput): Promise<HsRefund>
chargeOffSession(input: OffSessionInput): Promise<HsPayment>
```

```typescript
export type CreateIntentInput = {
  hsPaymentId: string; amountMinor: number; captureMethod: 'manual' | 'automatic';
  customerId: string; description: string; orderDetails: OrderDetail[];
  setupFutureUsage?: 'off_session'; returnUrl: string;
};
export type RefundInput = { hsPaymentId: string; amountMinor: number; reason: string };
export type OffSessionInput = {
  hsPaymentId: string; amountMinor: number; customerId: string;
  paymentMethodId: string; description: string;
};
```

Two extensions are needed for Tasks 15 and 17 (both detailed in their sections
below), plus one already-known open item:

- `RefundInput` needs an optional `refundId` field. Hyperswitch's `POST /refunds`
  accepts a merchant-supplied `refund_id` for idempotency (verified against
  `api-reference.hyperswitch.io` earlier this session, before the research tool went
  offline — this is a confirmed fact, not a guess). It is not used anywhere yet.
- Trip protection (Task 17) needs a way to create-and-confirm a payment server-side
  against the dummy connector, which `createIntent` cannot currently do (it has no
  `confirm` or card-data fields). See Task 17 below for the resolution.

### 8. The refund idempotency question from Task 6 is now closed — use it

Recorded as V-002-adjacent context back in Task 6/10: `POST /refunds` accepts an
optional `refund_id`, giving refunds the same "supply our own identifier" idempotency
pattern already used for payments (`hs_payment_id`, D-010). Task 15 below uses this.

---

## Task 13: Issuance — flows C and D

**Files:**
- Create: `lib/bookings/issue.ts`
- Modify: `lib/bookings/index.ts` (add `export * from './issue';`), `lib/state-machine.ts` (the guard fix in fact 4 above)
- Create: `app/api/bookings/[id]/issue/route.ts`
- Test: `tests/integration/issue.test.ts`

**Produces:** `issueTicket(bookingId: string): Promise<{ state: BookingState; ticketNumber?: string }>`

This is where the project's central invariant gets exercised for real: **capture
never precedes ticket issuance.** Authorize the card at checkout (done, Tasks 10–11),
attempt to issue the ticket, and only take the money once a ticket number exists.

```typescript
// lib/bookings/issue.ts
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { attemptIssuance } from '../ticketing';
import { capture, voidPayment } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

export async function issueTicket(
  bookingId: string,
): Promise<{ state: BookingState; ticketNumber?: string }> {
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${bookingId}`);

    // Idempotency: the row lock above serializes concurrent calls; a second
    // caller re-reads booking.state after the first commits and short-circuits
    // here rather than capturing twice. This does the same job withIdempotency
    // does elsewhere, but keyed on the booking's own state instead of a
    // caller-supplied key — appropriate here because issueTicket takes no input
    // besides bookingId, so the booking row *is* the natural key.
    if (booking.state === 'TICKETED') {
      return { state: booking.state, ticketNumber: booking.ticketNumber ?? undefined };
    }
    if (booking.state !== 'AUTHORIZED' && booking.state !== 'TICKETING') {
      throw new Error(`Cannot issue a ticket for a booking in state ${booking.state}`);
    }

    const payment = await flightPaymentFor(bookingId, tx);

    // D-007: refuse to proceed on a connector that cannot capture or void this
    // payment. Should never fire given the routing rules (D-005/D-006), but
    // this is the enforcement, not a formality.
    assertCapableOrThrow(payment.connector, 'flight');

    if (booking.state === 'AUTHORIZED') {
      const state = nextState('AUTHORIZED', 'ISSUANCE_STARTED');
      await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
      await recordEvent(bookingId, 'ticketing.attempted', {}, tx);
    }

    const issuance = await attemptIssuance(booking.itineraryId, bookingId);

    if (!issuance.ok && issuance.kind === 'retryable') {
      // Explicit self-loop through the state machine rather than an implicit
      // early return, so every transition — including no-ops — goes through
      // one auditable path.
      const state = nextState('TICKETING', 'ISSUANCE_FAILED_RETRYABLE');
      await recordEvent(bookingId, 'ticketing.failed', { kind: 'retryable', reason: issuance.reason }, tx);
      return { state };
    }

    if (!issuance.ok) {
      // Terminal failure. Void — the traveller is never charged for a seat
      // that will never exist (D-004).
      await voidPayment(payment.hsPaymentId, issuance.reason);
      const state = nextState('TICKETING', 'ISSUANCE_FAILED_TERMINAL');
      await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
      await tx.update(payments).set({ state: 'cancelled' }).where(eq(payments.id, payment.id));
      await recordEvent(bookingId, 'payment.voided', { reason: issuance.reason }, tx);
      return { state };
    }

    // Ticket exists. Only now do we take the money (D-002's whole point).
    await capture(payment.hsPaymentId, payment.amountMinor);
    const state = nextState('TICKETING', 'ISSUANCE_SUCCEEDED');
    await tx.update(bookings)
      .set({ state, ticketNumber: issuance.ticketNumber, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
    await tx.update(payments).set({ state: 'succeeded' }).where(eq(payments.id, payment.id));
    await recordEvent(bookingId, 'ticketing.succeeded', { ticketNumber: issuance.ticketNumber }, tx);
    await recordEvent(bookingId, 'payment.captured', { ticketNumber: issuance.ticketNumber }, tx);

    return { state, ticketNumber: issuance.ticketNumber };
  });
}
```

Note: both `ticketing.succeeded` and `payment.captured` are emitted on success —
`SCHEMA.md`'s event-type list documents both as distinct types and they mean
different things (a ticket existing vs. money moving); don't collapse them into one.

**A real, if narrow, risk to be aware of, not required to fully solve:** if `capture`
throws *after* Hyperswitch has actually captured the funds (a timeout, a dropped
connection), this transaction rolls back — `booking.state` reverts to `TICKETING` (or
stays `AUTHORIZED` if the rollback also undoes the `ISSUANCE_STARTED` transition,
depending on exactly where the throw happens) and a retry of `issueTicket` would call
`attemptIssuance` again. For a **stateful** itinerary like `itin_ord_lax`, a third call
to `attemptIssuance` advances its internal counter past the success threshold again
and returns a **new**, different ticket number — then this code calls `capture` a
*second* time on a payment that may already be captured. Whether Hyperswitch's
`capture` endpoint is idempotent for an already-captured payment (returns the existing
state cleanly) or errors is **unverified this session**. Treat this the same way
D-014 treated the analogous create-booking risk: acceptable for a prototype, recorded
rather than silently accepted. Add a line to `DECISIONS.md` (D-020) stating this
residual risk plainly, and note that the ops console (Task 16) — which shows live vs.
stored payment state side by side — is the detection mechanism, not an automatic fix.

**Route** (`app/api/bookings/[id]/issue/route.ts`):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { issueTicket } from '../../../../../lib/bookings';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await issueTicket(id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
```

**Tests** (`tests/integration/issue.test.ts`) — mock `lib/hyperswitch` and
`lib/ticketing` as needed; this is a database-touching integration test, so gate it
`describe.skipIf` exactly like `tests/integration/schema.test.ts:16-19,51`. Cover:
- Success: `itin_sfo_jfk` → `TICKETED`, a ticket number, `capture` called exactly once, and both `ticketing.succeeded` and `payment.captured` events recorded.
- Terminal failure: `itin_bos_sea` (the fixture that always fails terminally) → `VOIDED`, `voidPayment` called, `capture` never called.
- Idempotency: two sequential calls on the same successful booking → `capture` called exactly once (the second call short-circuits on `booking.state === 'TICKETED'`).
- The state-machine guard fix: a booking row with `state: 'QUOTED'` (not yet authorized) → `issueTicket` throws a clear error, not a crash.

Commit: `feat: ticket issuance capturing only after a ticket number exists`

---

## Task 14: DOT 24-hour cancellation — flow E

**Files:**
- Create: `lib/bookings/cancel.ts`
- Modify: `lib/bookings/index.ts` (add `export * from './cancel';`)
- Create: `app/api/bookings/[id]/cancel/route.ts`
- Test: `tests/integration/cancel.test.ts`

**Produces:** `cancelWithinWindow(bookingId: string, now?: Date): Promise<{ state: BookingState }>`

```typescript
// lib/bookings/cancel.ts
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { voidPayment } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

export async function cancelWithinWindow(
  bookingId: string,
  now: Date = new Date(),
): Promise<{ state: BookingState }> {
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${bookingId}`);

    if (booking.state === 'VOIDED') return { state: booking.state };

    if (booking.state !== 'AUTHORIZED') {
      throw new Error(
        `A booking in state ${booking.state} cannot be cancelled as a void; a captured booking must be refunded`,
      );
    }
    // Server time, deliberately, per the brief's own original comment — a
    // client-supplied "now" would let a traveller's clock skew extend the
    // window. `now` is a parameter only so tests can control it.
    if (!booking.voidDeadlineAt || now > booking.voidDeadlineAt) {
      throw new Error('Outside the 24 hour cancellation window');
    }

    const payment = await flightPaymentFor(bookingId, tx);
    assertCapableOrThrow(payment.connector, 'flight');

    await voidPayment(payment.hsPaymentId, 'dot_24h_cancellation');

    const state = nextState('AUTHORIZED', 'CANCELLED_IN_WINDOW');
    await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
    await tx.update(payments).set({ state: 'cancelled' }).where(eq(payments.id, payment.id));
    await recordEvent(bookingId, 'payment.voided', { reason: 'dot_24h_cancellation' }, tx);

    return { state };
  });
}
```

`voidPayment` failing here (network error, already voided at Hyperswitch) is lower
risk than the capture-side ambiguity in Task 13: voiding is naturally closer to
idempotent (calling cancel on an already-cancelled payment is expected to either
no-op or return a clear error, not silently double-void money that doesn't exist to
double-void). Wrap it in a `try/catch` anyway and record the outcome via
`recordEvent` either way, following the same pattern Task 12's webhook handler
already established for its own void call — don't let an unhandled rejection replace
a clean 400 response.

**Route** (`app/api/bookings/[id]/cancel/route.ts`) — same async-`params` shape as
Task 13's route.

**Tests** — gate as an integration test. Cover: void succeeds inside the window;
refuses outside the window using an injected `now` (never rely on real wall-clock
time in a test); a booking already `VOIDED` returns cleanly rather than erroring
(idempotent no-op); a booking in `TICKETED` is rejected with a message pointing at
refund instead.

Commit: `feat: DOT 24-hour cancellation as a void with server-side deadline`

---

## Task 15: Refunds — flow F

**Files:**
- Modify: `lib/hyperswitch.ts`, `lib/hyperswitch.types.ts` (add `refundId` to `RefundInput`)
- Create: `lib/bookings/refund.ts`
- Modify: `lib/bookings/index.ts` (add `export * from './refund';`)
- Create: `app/api/bookings/[id]/refund/route.ts`
- Test: `tests/integration/refund.test.ts`

**Produces:** `refundBooking(input: { bookingId: string; amountMinor: number; reason: string }): Promise<{ state: BookingState }>`

### Design correction: use `withIdempotency`, not a bespoke mechanism

The plan document's draft brief for this task does **not** call `withIdempotency` —
it invents a separate mechanism: insert a `refunds` row first, let the
`(payment_id, reason)` unique index reject a duplicate, and only call Hyperswitch
after the insert succeeds. That's a real, working guard against literal double
submission, but it's a second, weaker idempotency mechanism sitting next to the one
Tasks 10 and 18 already use, and it doesn't have `withIdempotency`'s "release the
claim only if `fn` throws" property. **Use `withIdempotency`** instead, for
consistency with the rest of the codebase and because it's the mechanism this project
has already reviewed and hardened twice (Task 8, Task 10).

Key the claim deterministically from the natural key — `refundBooking` doesn't take a
caller-supplied idempotency key in its signature, so derive one:

```typescript
const idempotencyKey = `refund:${payment.id}:${input.reason}`;
```

### Extend `RefundInput` first

```typescript
// lib/hyperswitch.types.ts — add one optional field
export type RefundInput = {
  hsPaymentId: string;
  amountMinor: number;
  reason: string;
  refundId?: string;   // merchant-supplied idempotency id; see lib/hyperswitch.ts
};
```

```typescript
// lib/hyperswitch.ts — in the refund() function, include refund_id when supplied
export function refund(input: RefundInput): Promise<HsRefund> {
  return call<HsRefund>('/refunds', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    reason: input.reason,
    ...(input.refundId ? { refund_id: input.refundId } : {}),
  });
}
```

(The internal `call<T>(path, body?, method?)` helper takes `path` first — verify the
exact signature in `lib/hyperswitch.ts` before editing; match `refund`'s existing call
shape and only add the `refund_id` line, not a full rewrite.)

Passing our own `refund_id` (derived the same way `toHsPaymentId` derives
`hs_payment_id` — a `newId()` ULID) gives Hyperswitch's own API the same idempotency
protection `hs_payment_id` gives payment creation (D-010). This closes the "does
Hyperswitch accept a merchant refund identifier" question that was left open after
Task 6 — it does, verified against the live API reference earlier this session.

### `lib/bookings/refund.ts`

```typescript
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, refunds } from '../../db';
import { refund as hsRefund } from '../hyperswitch';
import { withIdempotency } from '../idempotency';
import { newId } from '../ids';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

export async function refundBooking(input: {
  bookingId: string;
  amountMinor: number;
  reason: string;
}): Promise<{ state: BookingState }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
  if (!booking) throw new Error(`Unknown booking ${input.bookingId}`);
  if (booking.state !== 'TICKETED' && booking.state !== 'PARTIALLY_REFUNDED') {
    throw new Error(`Cannot refund a booking in state ${booking.state}`);
  }

  const payment = await flightPaymentFor(input.bookingId);

  const existing = await db.select().from(refunds).where(eq(refunds.paymentId, payment.id));
  const alreadyRefunded = existing.reduce((sum, r) => sum + r.amountMinor, 0);
  if (alreadyRefunded + input.amountMinor > payment.amountMinor) {
    throw new Error(
      `Refund exceeds captured amount: ${alreadyRefunded} + ${input.amountMinor} > ${payment.amountMinor}`,
    );
  }

  const key = `refund:${payment.id}:${input.reason}`;

  const { result } = await withIdempotency(
    key,
    '/api/bookings/refund',
    { bookingId: input.bookingId, amountMinor: input.amountMinor, reason: input.reason },
    async () => {
      const refundId = newId();

      const hsResult = await hsRefund({
        hsPaymentId: payment.hsPaymentId,
        amountMinor: input.amountMinor,
        reason: input.reason,
        refundId,
      });

      // The (payment_id, reason) unique index (SCHEMA.md) remains as
      // defense-in-depth and as the queryable record of what was refunded —
      // withIdempotency is now the primary guard against a duplicate call.
      await db.insert(refunds).values({
        id: refundId, paymentId: payment.id, hsRefundId: hsResult.refund_id,
        amountMinor: input.amountMinor, reason: input.reason, state: hsResult.status,
      });

      const total = alreadyRefunded + input.amountMinor;
      const state = nextState(
        booking.state as BookingState,
        total >= payment.amountMinor ? 'REFUNDED_FULL' : 'REFUNDED_PARTIAL',
      );
      await db.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, input.bookingId));
      await recordEvent(input.bookingId, 'refund.created', { amount: input.amountMinor, reason: input.reason });

      return { state };
    },
  );

  return result;
}
```

**On the ambiguous-failure treatment `withIdempotency`'s contract asks for:** unlike
Task 10 (create-booking) and Task 18 (ancillary charge), a full read-back-before-throw
implementation for `hsRefund` would need a `GET /refunds/{id}` endpoint, whose
existence is **unverified this session**. Rather than guess at an unverified
endpoint, accept this as a recorded, asymmetric risk: if `hsRefund` throws
ambiguously (the refund may have gone through, response lost), the idempotency key
releases and a retry could issue a second refund. This is real, but lower-severity
than the equivalent create-booking risk — a duplicate *refund* costs the merchant
money and requires an ops person to notice and reconcile (visible via the ops console,
Task 16, or a Hyperswitch dashboard check), it does not silently overcharge a
traveller a second time the way a duplicate payment creation would. Record this
explicitly in `DECISIONS.md` (D-021), including that if a `GET /refunds/{id}`
endpoint is confirmed to exist, the correct fix mirrors `createIntentOrReadBack`
exactly (attempt `hsRefund`; on failure, read back by the `refundId` we supplied;
continue with the existing refund if found; throw only if genuinely absent).

**Route** (`app/api/bookings/[id]/refund/route.ts`) — async `params`, body validated
with `zod`: `{ amountMinor: z.number().int().positive(), reason: z.string().min(1) }`.

**Tests** — gate as integration. Cover:
- Partial refund on a `TICKETED` booking → `PARTIALLY_REFUNDED`.
- The same `(bookingId, reason)` refunded twice → `hsRefund`/`refund` called exactly once (proves `withIdempotency`, not the DB constraint, is doing the deduping).
- A refund amount exceeding what was captured → rejected before any Hyperswitch call.
- **New, closes a Task 4 finding:** two *different*-reason partial refunds against the same booking, together reaching the full captured amount → second refund transitions `PARTIALLY_REFUNDED → REFUNDED` via the `REFUNDED_FULL` event; and a third partial-refund call once already `PARTIALLY_REFUNDED` exercises the `PARTIALLY_REFUNDED --REFUNDED_PARTIAL--> PARTIALLY_REFUNDED` self-loop in `lib/state-machine.ts`, which has existed since Task 4 but was never tested until now.

Commit: `feat: partial and full refunds guarded by withIdempotency and a merchant refund_id`

---

## Task 16: Operations console

**Files:**
- Create: `app/api/ops/bookings/route.ts`
- Create: `app/ops/page.tsx`

**No new interfaces consumed by later tasks.** Read-only-plus-action-buttons view over
what Tasks 10–15 already built.

```typescript
// app/api/ops/bookings/route.ts
import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../../../db';
import { getPayment } from '../../../../lib/hyperswitch';

export async function GET() {
  const rows = await db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(25);

  const enriched = await Promise.all(rows.map(async (b) => {
    const [p] = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    let live: string | null = null;
    try {
      live = p ? (await getPayment(p.hsPaymentId)).status : null;
    } catch {
      live = 'unreachable';
    }
    return {
      ...b,
      hsPaymentId: p?.hsPaymentId ?? null,
      connector: p?.connector ?? null,
      storedPaymentState: p?.state ?? null,
      livePaymentState: live,
      diverged: p ? live !== p.state : false,
    };
  }));

  return NextResponse.json(enriched);
}
```

This route makes one live Hyperswitch call per booking on every page load. Fine for
a demo (25-row limit, low traffic); note in a comment that a production version would
rely on webhook-driven state and only spot-check live state on demand, not on every
poll.

`app/ops/page.tsx`: a client component, table with one row per booking — PNR,
itinerary, amount (via `formatUsd` from `lib/money.ts`, never a raw number), booking
state, connector, `hs_payment_id` (selectable text, for cross-referencing the
Hyperswitch Control Center), stored vs. live payment state with **divergence
highlighted** (`diverged: true` — a strong visual signal, this is D-011's
"reconciliation is surfaced, not automated" principle made visible), and action
buttons:

- **Issue ticket** when state is `AUTHORIZED` or `TICKETING`
- **Cancel** when state is `AUTHORIZED`
- **Refund** when state is `TICKETED` or `PARTIALLY_REFUNDED`

Bookings in `TICKETING` render first, visually distinct — that's the state where
funds are held and no ticket exists yet, the single most operationally urgent state
in the whole system.

Every action button disables itself while its own request is in flight — same
double-click discipline as the checkout Pay button (Task 11).

**This page has no authentication.** That is a known, accepted simplification for
this prototype — say so explicitly in a code comment at the top of `page.tsx`, and it
must also appear in Task 19's README "Known simplifications" section. Do not add auth
here; that's out of scope and the plan never asked for it.

**Hand-verify:** book, confirm the row appears `AUTHORIZED`, click Issue ticket,
watch it become `TICKETED` with live state `succeeded`. Cross-reference
`hs_payment_id` against the Hyperswitch Control Center if reachable.

Commit: `feat: operations console with stored vs live payment state`

---

## Task 17: Trip protection — flow G

**Files:**
- Modify: `lib/hyperswitch.ts`, `lib/hyperswitch.types.ts` (new function, see design note below)
- Create: `lib/bookings/protection.ts`
- Modify: `lib/bookings/index.ts` (add `export * from './protection';`), `SCHEMA.md` (new event type)
- Create: `app/api/bookings/[id]/protection/route.ts`
- Test: `tests/integration/protection.test.ts`

**Produces:** `addTripProtection(bookingId: string): Promise<{ connector: string | null }>`

### Design gap found and resolved — read this before implementing

The plan document's draft brief calls `createIntent` for trip protection and expects
`intent.status` to come back `'succeeded'` immediately. **This cannot work as
written.** `CreateIntentInput` (Task 6, already shipped and reviewed) has no `confirm`
field and no card-data field — `createIntent` can only ever produce an *unconfirmed*
intent (`requires_payment_method` or similar), exactly like it does for the flight
leg in Task 10. Something has to actually confirm the payment — supply card details
and trigger authorization — or it never charges anything.

For the **flight** leg, that "something" is the traveller, via the Hyperswitch SDK in
the browser (Task 11). Trip protection doesn't have an obvious equivalent: at the
point `addTripProtection` would run, the traveller has no saved payment method yet
(that only exists *after* the flight payment confirms with `setup_future_usage`), so
this can't reuse `chargeOffSession` either.

**Resolution:** trip protection is deliberately routed to `fauxpay`, Hyperswitch's
dummy connector, specifically because it needs no real payment credentials and cannot
move real money (verified from source, D-001/D-005/D-006). This project already has
a proven precedent for sending fixed, non-sensitive test card data server-side to
this exact dummy connector for exactly this reason: `scripts/smoke.ts` does it, and
`probe-fauxpay.ps1` (used during the Task 2 investigation) proved a server-side
`confirm: true` call against `fauxpay` with card `4242424242424242` returns
`succeeded` immediately. Reuse that pattern here: it involves no real cardholder
data (the "card number" is Hyperswitch's own published test value, understood by
`fauxpay` only, and never used against the real flight connector).

Add one narrowly-scoped function to `lib/hyperswitch.ts` — do not extend
`createIntent` itself, to avoid complicating its existing, already-reviewed contract:

```typescript
// lib/hyperswitch.types.ts
export type DummyAutoChargeInput = {
  hsPaymentId: string;
  amountMinor: number;
  customerId: string;
  description: string;
  orderDetails: OrderDetail[];
};
```

```typescript
// lib/hyperswitch.ts
/**
 * Creates AND immediately confirms a payment using a fixed Hyperswitch test
 * card, server-side, with no browser SDK involved.
 *
 * ONLY for the trip-protection flow, which is deliberately routed to
 * `fauxpay` (the dummy connector) by the `amount < $50` rule (D-005). Never
 * use this for the flight leg or any payment that could route to a real
 * connector — sending raw card data server-side to a real PSP is exactly
 * what got Stripe removed from this project (D-012). This function is safe
 * only because `fauxpay` is synthetic: no real card data ever exists, and
 * this exact server-side-confirm pattern is already used in
 * `scripts/smoke.ts` for the same reason.
 */
export async function createAndConfirmDummyCharge(
  input: DummyAutoChargeInput,
): Promise<HsPayment> {
  return call<HsPayment>('/payments', {
    amount: input.amountMinor,
    currency: 'USD',
    confirm: true,
    capture_method: 'automatic',
    authentication_type: 'no_three_ds',
    profile_id: env.HYPERSWITCH_PROFILE_ID,
    payment_id: input.hsPaymentId,
    customer_id: input.customerId,
    description: input.description,
    order_details: input.orderDetails,
    payment_method: 'card',
    payment_method_type: 'credit',
    payment_method_data: {
      card: {
        card_number: '4242424242424242',
        card_exp_month: '12',
        card_exp_year: '2030',
        card_cvc: '123',
        card_holder_name: 'Trip Protection',
      },
    },
  });
}
```

(Match this to whatever internal `call<T>` helper `createIntent`/`capture` already
use in the current file — reuse it, don't duplicate request-building logic. Confirm
the exact field names against `createIntent`'s existing body before committing; the
shape above should match it closely since both build a `POST /payments` request.)

Record this as **D-022** in `DECISIONS.md`: what was chosen (server-side auto-confirm
against the dummy connector only), what was rejected (a second SDK-confirmed checkout
step, which would need a second `client_secret` and a second widget mount — real UX
complexity for a $24 add-on the spec already treats as "off the critical path"), and
why (fauxpay is synthetic, the pattern is already proven in this codebase, and the
amount-based routing rule guarantees this call can never reach a real connector).

### `lib/bookings/protection.ts`

```typescript
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, type PaymentKind } from '../../db';
import { newId, toHsPaymentId } from '../ids';
import { createAndConfirmDummyCharge } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { recordEvent } from '../events';
import { env } from '../env';

const TRIP_PROTECTION_MINOR = 2400;   // $24.00 — below the $50 routing threshold (D-005)

export async function addTripProtection(bookingId: string): Promise<{ connector: string | null }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw new Error(`Unknown booking ${bookingId}`);

  const paymentId = newId();
  const hsPaymentId = toHsPaymentId(paymentId);

  // The partial unique index on (booking_id, kind) — SCHEMA.md — rejects a
  // second protection payment for this booking. Insert first, same principle
  // as the refund guard: let the database reject a duplicate before any
  // money moves.
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'protection' satisfies PaymentKind, hsPaymentId,
    amountMinor: TRIP_PROTECTION_MINOR, captureMethod: 'automatic', state: 'pending',
  });

  const charged = await createAndConfirmDummyCharge({
    hsPaymentId,
    amountMinor: TRIP_PROTECTION_MINOR,
    customerId: booking.customerId!,
    description: 'Trip protection',
    orderDetails: [{ product_name: 'Trip protection', quantity: 1, amount: TRIP_PROTECTION_MINOR }],
  });

  // D-007: this is now a real, post-confirmation connector value — not the
  // premature null Task 10 correctly avoided asserting against at
  // create-intent time. Run the check for real, even though `protection`'s
  // current REQUIREMENTS (lib/connector-capabilities.ts) list no required
  // capabilities, so this can never throw today — it's here so that if a
  // future kind or a changed REQUIREMENTS table ever does require something,
  // this call site doesn't need to be revisited to start enforcing it.
  assertCapableOrThrow(charged.connector, 'protection');

  await db.update(payments)
    .set({ connector: charged.connector, state: charged.status, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));
  await recordEvent(bookingId, 'protection.added', { connector: charged.connector });

  return { connector: charged.connector };
}
```

`protection.added` is a new event type — add it to `SCHEMA.md`'s event-type list
(`booking_events` section) in the same commit, per the global constraint that a
schema/spec divergence gets reconciled immediately, not left implicit.

**Route** (`app/api/bookings/[id]/protection/route.ts`) — async `params`, `POST`, no
body needed beyond the id.

**CheckoutForm.tsx change:** add a checkbox — "Add trip protection ($24.00)" — that,
on submit, calls `POST /api/bookings/[id]/protection` **before** `hyper.confirmPayment`
for the flight leg (order doesn't matter functionally since they're independent
payments, but doing protection first means a failure there doesn't strand a
successfully-confirmed flight payment behind it). If the protection call fails, show
an error but let the traveller retry the flight payment independently — a failed
$24 add-on must never block the $600+ flight purchase.

**Tests** — gate as integration. Cover: protection payment lands on `fauxpay` with
`status: succeeded` (mock `createAndConfirmDummyCharge`, matching `authorizedotnet`/
`fauxpay` naming — not `stripe`); a second call for the same booking is rejected by
the unique index; `db.insert` failing leaves no orphaned Hyperswitch charge to clean
up (this direction is safe by construction — the insert happens *before* the charge,
so an insert failure means the charge attempt never happens at all).

Commit: `feat: trip protection auto-confirmed against the dummy connector`

---

## Task 18: Post-booking ancillary charge — flow H

**Files:**
- Create: `lib/bookings/ancillary.ts`
- Modify: `lib/bookings/index.ts` (add `export * from './ancillary';`), `app/api/webhooks/hyperswitch/route.ts` (capture `payment_method_id`, see Step below)
- Create: `app/api/bookings/[id]/ancillary/route.ts`
- Test: `tests/integration/ancillary.test.ts`

**Produces:** `chargeAncillary(input: { bookingId: string; description: string; amountMinor: number; idempotencyKey: string }): Promise<{ status: string }>`

This is the highest-risk task in this batch: it calls `withIdempotency` directly,
same as Task 10, and it charges a real card off-session. It needs the exact same
ambiguous-failure treatment Task 10's `createIntentOrReadBack` established — read
`lib/idempotency.ts`'s "Contract on `fn`" JSDoc again before writing this.

```typescript
// lib/bookings/ancillary.ts
import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { chargeOffSession, getPayment } from '../hyperswitch';
import { withIdempotency } from '../idempotency';
import { newId, toHsPaymentId } from '../ids';
import { recordEvent } from '../events';

/**
 * Mirrors `createIntentOrReadBack` (lib/bookings/create.ts, task-10
 * correction 1): if `chargeOffSession` throws, the payment may have actually
 * gone through at Hyperswitch before the response was lost. Read it back by
 * the id we control before deciding the charge genuinely failed. Per
 * withIdempotency's contract, a throw from this function releases the
 * idempotency key — so a throw here must mean the charge is confirmed NOT
 * to have happened, not merely that our HTTP call failed.
 */
async function chargeOrReadBack(
  hsPaymentId: string,
  input: Parameters<typeof chargeOffSession>[0],
) {
  try {
    return await chargeOffSession(input);
  } catch (err) {
    const readBack = await getPayment(hsPaymentId).catch(() => undefined);
    if (readBack) return readBack;
    throw err;
  }
}

export async function chargeAncillary(input: {
  bookingId: string;
  description: string;
  amountMinor: number;
  idempotencyKey: string;
}): Promise<{ status: string }> {
  const { result } = await withIdempotency(
    input.idempotencyKey,
    '/api/bookings/ancillary',
    { bookingId: input.bookingId, amountMinor: input.amountMinor, description: input.description },
    async () => {
      const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
      if (!booking) throw new Error(`Unknown booking ${input.bookingId}`);
      if (booking.state !== 'TICKETED') {
        throw new Error(`Cannot charge an ancillary on a booking in state ${booking.state}`);
      }
      if (!booking.paymentMethodId) {
        throw new Error(
          'No stored payment method for this booking; the traveller did not consent to save their card at checkout',
        );
      }

      const paymentId = newId();
      const hsPaymentId = toHsPaymentId(paymentId);

      await db.insert(payments).values({
        id: paymentId, bookingId: input.bookingId, kind: 'ancillary', hsPaymentId,
        amountMinor: input.amountMinor, captureMethod: 'automatic', state: 'pending',
      });

      const charged = await chargeOrReadBack(hsPaymentId, {
        hsPaymentId,
        amountMinor: input.amountMinor,
        customerId: booking.customerId!,
        paymentMethodId: booking.paymentMethodId,
        description: input.description,
      });

      await db.update(payments)
        .set({ connector: charged.connector, state: charged.status, updatedAt: new Date() })
        .where(eq(payments.id, paymentId));
      await recordEvent(input.bookingId, 'ancillary.charged', {
        description: input.description, amount: input.amountMinor,
      });

      return { status: charged.status };
    },
  );
  return result;
}
```

**`REQUIREMENTS.ancillary` needs `mit: true`** (already true in
`lib/connector-capabilities.ts` per Task 12's review) — this is the **first task in
the entire project that actually exercises MIT/off-session charging against
Authorize.net for real.** `lib/connector-capabilities.ts`'s comment on `mit` for
`authorizedotnet` says explicitly: *"source only, never exercised live"* (Task 7,
carried through Task 12). **This task is where that stops being true.** After the
first successful hand-test, update that comment to point at a new verification entry
in `DECISIONS.md` (V-004) recording the live result, the same way V-001 closed the
capture/void question. If it does NOT work — if Authorize.net's `SetupMandate`/MIT
support turns out not to function in this sandbox — that is a Task-2-level finding:
stop, do not paper over it, record it as a decision, and report it rather than
guessing at a workaround.

**Step 4 — capture `payment_method_id` at the webhook, not here.** This function
needs `booking.paymentMethodId` to already be populated, and nothing sets it yet.
Modify `app/api/webhooks/hyperswitch/route.ts` (Task 12, already shipped): when a
flight payment's webhook event carries a `payment_method_id` field (same
undefined-vs-null defensive extraction pattern already used there for `connector`,
per D-018), persist it to `bookings.paymentMethodId`. This field's presence in the
webhook payload is **equally unverified** as `connector` was — apply the identical
reasoning: skip when the field is `undefined`, act when it's present (including a
genuine `null`, which — same as the connector case — is a legitimate value before a
payment method exists to reference).

If, once this is testable live, the webhook does *not* carry the field: the fallback
is a `getPayment` read immediately after the flight payment's confirm step succeeds
(Task 11's confirmation page already calls `getPayment` live — that's the natural
place to persist it if the webhook path doesn't pan out). Note this fallback in
`DECISIONS.md` rather than silently switching to it.

**Route** — async `params`, `POST`, body `{ description: string, amountMinor: number, idempotencyKey: string }` validated with `zod`.

**Tests** — gate as integration. Cover: refuses when no payment method was saved;
charges off-session when one exists (mock `chargeOffSession`, connector
`authorizedotnet` not `stripe`); the same idempotency key charged twice → `chargeOffSession`/`chargeOrReadBack` called exactly once; **new — the ambiguous-failure path**: mock `chargeOffSession` to reject and `getPayment` to resolve with a real charged payment, assert `chargeAncillary` succeeds without a second charge attempt (mirrors Task 10's Correction-1 test exactly).

Commit: `feat: off-session ancillary charge with read-back on ambiguous failure`

---

## Task 19: End-to-end verification, seed script and README

**Files:**
- Create: `scripts/seed.ts`, `README.md`
- Modify: `package.json` (scripts)

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:watch": "vitest",
    "smoke": "tsx -r dotenv/config scripts/smoke.ts",
    "seed": "tsx -r dotenv/config scripts/seed.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  }
}
```

(`test:unit` already exists from Task 5 — keep it. `dev`/`build`/`start` already
exist from Task 11 — keep them, don't duplicate.)

**`scripts/seed.ts`** — creates one booking in each demonstrable state so the ops
console (Task 16) is populated at the start of a walkthrough: one `AUTHORIZED`
awaiting issuance, one `TICKETED`, one `VOIDED` from a failed issuance
(`itin_bos_sea`), one `PARTIALLY_REFUNDED`. Run this against the live sandbox using
the already-built `createBooking`/`issueTicket`/`refundBooking` functions directly —
do not hand-craft database rows; the seed data must be exactly as real as anything a
traveller produces, so it demonstrates the actual code paths.

**Run this on demo day, not before.** Dummy-connector (`fauxpay`) payments expire
after two days (`DECISIONS.md`'s deferred-items table), so seeded trip-protection
data goes stale if seeded early.

**README.md** must cover:
- What this is and the vertical (US OTA, merchant of record, flights).
- One-paragraph architecture summary.
- Setup from a cold start: Hyperswitch sandbox account, **Authorize.net sandbox
  account** (not Stripe — `README.md` must not repeat the plan document's stale
  Stripe instructions; link to D-012 for why), connecting both connectors plus
  `fauxpay`, the `amount < $50` routing rule, `.env` population, migrations.
- How to run `npm run smoke` and interpret its output.
- The demo script, in order: book → checkout → issue → (optionally) cancel or refund
  → view in ops console.
- Test cards: `4242424242424242` for success. **Do not list `4000000000000002` as a
  decline trigger** — that's Stripe's card and does nothing on Authorize.net (V-001).
  State the actual trigger: billing ZIP `46282` produces a decline on Authorize.net,
  and note that this trigger is **not reachable through the browser checkout** on the
  current sandbox account (D-016) — the decline is demonstrable via `npm run smoke`
  or the API directly, not through the UI, until/unless that account limitation is
  resolved.
- Links to `FEATURE_booking_payments.md`, `SCHEMA.md`, `DECISIONS.md`.
- A **Known simplifications** section, stated plainly: the GDS is simulated
  (`lib/ticketing.ts`); the retryable-issuance counter is in-memory and resets on a
  cold start (serverless-unsafe by design, documented in the file itself); there is
  no authentication on `/ops`; the browser-driven decline demo is unavailable on this
  sandbox account (D-016) — decline is proven via the API/smoke script instead; MIT/
  off-session charging (flow H) depends on Authorize.net capability that was
  source-verified but not live-tested until Task 18.

**Run the full suite:** `npm test` — expected all green, matching whatever count
Task 18 leaves it at (97 plus each new task's additions).

**Run both end-to-end paths against the real sandbox:**
- Book `itin_sfo_jfk` → issue → confirm `succeeded` (live, via the ops console or a direct API check).
- Book `itin_bos_sea` → issue → confirm `cancelled`/`VOIDED` and that no capture occurred.

Commit: `docs: README, seed script and end-to-end verification`

---

## Summary of new decisions to record

| # | Task | What |
| --- | --- | --- |
| D-020 | 13 | Residual risk: `capture` called twice if it throws ambiguously after a real capture; accepted, ops-console-visible, not auto-remediated |
| D-021 | 15 | `withIdempotency` adopted for refunds in place of the plan's bespoke insert-then-catch mechanism; ambiguous-`hsRefund`-failure read-back deferred pending verification that `GET /refunds/{id}` exists |
| D-022 | 17 | Trip protection auto-confirmed server-side against the dummy connector with fixed test card data; why this is safe (routing-guaranteed, precedented in `scripts/smoke.ts`) and why a second SDK step was rejected |
| D-023 (if needed) | 18 | Live verification result for MIT/off-session charging on Authorize.net — record as V-004 instead if it's a straightforward confirmation rather than a judgment call |

## DB impact

**None.** Every table, column, index and constraint Tasks 13–19 need already exists
(`bookings`, `payments`, `refunds`, `booking_events`, `idempotency_records` — all
shipped in Task 5). No migration is required for this batch. `SCHEMA.md` needs two
additive documentation updates only: the `protection.added` event type (Task 17) and
confirmation that `ancillary.charged` (already listed) is now actually emitted
(Task 18) — no `CREATE TABLE`/`ALTER TABLE` involved.
