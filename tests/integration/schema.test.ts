// Integration test against the real Neon sandbox database. Proves the
// idempotency guards in SCHEMA.md are enforced by Postgres constraints, not
// by application code (decision D-010): the double-charge guard on
// payments (booking_id, kind), the hs_payment_id length check, and the
// refund (payment_id, reason) guard.
//
// Every row this file inserts is deleted in afterAll so repeat runs against
// the shared database start clean, and the pool is closed so vitest exits
// without an open-handle warning.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, bookings, payments, refunds } from '../../db';
import { newId, toHsPaymentId } from '../../lib/ids';

// Drizzle wraps the underlying driver error in a DrizzleQueryError whose
// `.cause` is the raw Postgres error carrying `code` (SQLSTATE) and
// `constraint` (the constraint/index name that fired). Unwrap it so the
// assertion pins down which guard fired, not just that something threw.
function isPgError(err: unknown, code: string, constraint: string): boolean {
  const cause = typeof err === 'object' && err !== null && 'cause' in err
    ? (err as { cause?: unknown }).cause
    : undefined;
  const pgErr = cause ?? err;
  if (typeof pgErr !== 'object' || pgErr === null) return false;
  const { code: actualCode, constraint: actualConstraint } = pgErr as {
    code?: unknown;
    constraint?: unknown;
  };
  return actualCode === code && actualConstraint === constraint;
}

describe('schema constraints', () => {
  let bookingId: string;
  let flightPaymentId: string;
  const insertedPaymentIds: string[] = [];

  beforeAll(async () => {
    bookingId = newId();
    await db.insert(bookings).values({
      id: bookingId, pnr: `T${Date.now()}`, itineraryId: 'itin_1',
      passengers: [], amountMinor: 65400,
    });

    flightPaymentId = newId();
    insertedPaymentIds.push(flightPaymentId);
    await db.insert(payments).values({
      id: flightPaymentId, bookingId, kind: 'flight',
      hsPaymentId: toHsPaymentId(flightPaymentId),
      amountMinor: 65400, captureMethod: 'manual', state: 'requires_capture',
    });
  });

  afterAll(async () => {
    await db.delete(refunds).where(eq(refunds.paymentId, flightPaymentId));
    for (const id of insertedPaymentIds) {
      await db.delete(payments).where(eq(payments.id, id));
    }
    await db.delete(bookings).where(eq(bookings.id, bookingId));
    // Close the pooled websocket connection so vitest can exit cleanly.
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('rejects a second flight payment for the same booking', async () => {
    const id = newId();
    const insertSecondFlight = db.insert(payments).values({
      id, bookingId, kind: 'flight', hsPaymentId: toHsPaymentId(id),
      amountMinor: 65400, captureMethod: 'manual', state: 'requires_capture',
    });

    await expect(insertSecondFlight).rejects.toThrow();
    try {
      await insertSecondFlight;
    } catch (err) {
      expect(isPgError(err, '23505', 'payments_one_per_kind_idx')).toBe(true);
    }
  });

  it('rejects an hs_payment_id that is not exactly 30 characters', async () => {
    const id = newId();
    const insertBadLength = db.insert(payments).values({
      id, bookingId, kind: 'ancillary', hsPaymentId: 'too_short',
      amountMinor: 3500, captureMethod: 'automatic', state: 'succeeded',
    });

    await expect(insertBadLength).rejects.toThrow();
    try {
      await insertBadLength;
    } catch (err) {
      expect(isPgError(err, '23514', 'hs_payment_id_is_30_chars')).toBe(true);
    }
  });

  it('allows several ancillary payments for one booking', async () => {
    for (let i = 0; i < 3; i++) {
      const id = newId();
      insertedPaymentIds.push(id);
      await db.insert(payments).values({
        id, bookingId, kind: 'ancillary', hsPaymentId: toHsPaymentId(id),
        amountMinor: 3500, captureMethod: 'automatic', state: 'succeeded',
      });
    }
    const ancillaries = await db.select().from(payments)
      .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'ancillary')));
    expect(ancillaries).toHaveLength(3);
  });

  it('rejects a duplicate refund reason for the same payment', async () => {
    const firstRefundId = newId();
    await db.insert(refunds).values({
      id: firstRefundId, paymentId: flightPaymentId, amountMinor: 1000,
      reason: 'customer_request', state: 'pending',
    });

    const secondRefundId = newId();
    const insertDuplicateReason = db.insert(refunds).values({
      id: secondRefundId, paymentId: flightPaymentId, amountMinor: 500,
      reason: 'customer_request', state: 'pending',
    });

    await expect(insertDuplicateReason).rejects.toThrow();
    try {
      await insertDuplicateReason;
    } catch (err) {
      expect(isPgError(err, '23505', 'refunds_one_per_reason_idx')).toBe(true);
    }
  });
});
