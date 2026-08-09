// Integration test against the real Neon sandbox database for
// cancelWithinWindow (Task 14, flow E — the US DOT 24-hour rule): a void
// inside the window, a refusal outside it (with an injected clock, never
// wall time), an idempotent no-op on an already-VOIDED booking, and a
// TICKETED booking pointed at refund instead.
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured.
// Rows are deleted in afterAll in FK order; the pool is closed so vitest
// exits cleanly.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, bookingEvents } from '../../db';
import { newId, toHsPaymentId } from '../../lib/ids';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(),
  getPayment: vi.fn(),
  capture: vi.fn(),
  voidPayment: vi.fn(),
}));

const DEADLINE = new Date('2026-08-10T12:00:00Z');

async function seedBooking(state: 'AUTHORIZED' | 'VOIDED' | 'TICKETED') {
  const bookingId = newId();
  const paymentId = newId();
  await db.insert(bookings).values({
    id: bookingId, pnr: `C${Date.now()}${Math.floor(Math.random() * 1000)}`,
    itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
    amountMinor: 35250, state, customerId: `cus_${bookingId}`,
    voidDeadlineAt: DEADLINE,
  });
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'flight', hsPaymentId: toHsPaymentId(paymentId),
    amountMinor: 35250, captureMethod: 'manual', connector: 'authorizedotnet',
    state: state === 'VOIDED' ? 'cancelled' : 'requires_capture',
  });
  return bookingId;
}

describe.skipIf(!hasRealDatabase)('cancelWithinWindow (requires a real DATABASE_URL)', () => {
  const createdBookingIds: string[] = [];

  beforeEach(async () => {
    const { voidPayment } = await import('../../lib/hyperswitch');
    vi.mocked(voidPayment).mockReset();
    vi.mocked(voidPayment).mockImplementation(async (id: string) => ({
      payment_id: id, status: 'cancelled', connector: 'authorizedotnet',
      client_secret: null, amount: 35250, amount_capturable: 0,
      amount_received: null, payment_method_id: null,
      error_message: null, error_code: null,
    }));
  });

  afterAll(async () => {
    for (const bookingId of createdBookingIds) {
      await db.delete(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
      await db.delete(payments).where(eq(payments.bookingId, bookingId));
      await db.delete(bookings).where(eq(bookings.id, bookingId));
    }
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('voids inside the window and records payment.voided', async () => {
    const { cancelWithinWindow } = await import('../../lib/bookings');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await seedBooking('AUTHORIZED');
    createdBookingIds.push(bookingId);

    const inside = new Date(DEADLINE.getTime() - 60 * 60 * 1000);
    const result = await cancelWithinWindow(bookingId, inside);
    expect(result.state).toBe('VOIDED');
    expect(vi.mocked(voidPayment)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(voidPayment).mock.calls[0][1]).toBe('dot_24h_cancellation');

    const [payment] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    expect(payment.state).toBe('cancelled');

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    expect(events.map((e) => e.type)).toContain('payment.voided');
  });

  it('refuses outside the window without touching Hyperswitch', async () => {
    const { cancelWithinWindow } = await import('../../lib/bookings');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await seedBooking('AUTHORIZED');
    createdBookingIds.push(bookingId);

    const outside = new Date(DEADLINE.getTime() + 60 * 1000);
    await expect(cancelWithinWindow(bookingId, outside))
      .rejects.toThrow(/Outside the 24 hour cancellation window/);
    expect(vi.mocked(voidPayment)).not.toHaveBeenCalled();

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.state).toBe('AUTHORIZED');
  });

  it('an already-VOIDED booking is an idempotent no-op, not an error', async () => {
    const { cancelWithinWindow } = await import('../../lib/bookings');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await seedBooking('VOIDED');
    createdBookingIds.push(bookingId);

    const result = await cancelWithinWindow(bookingId, new Date(0));
    expect(result.state).toBe('VOIDED');
    expect(vi.mocked(voidPayment)).not.toHaveBeenCalled();
  });

  it('rejects a TICKETED booking with a message pointing at refund', async () => {
    const { cancelWithinWindow } = await import('../../lib/bookings');
    const bookingId = await seedBooking('TICKETED');
    createdBookingIds.push(bookingId);

    await expect(cancelWithinWindow(bookingId, new Date(0)))
      .rejects.toThrow(/must be refunded/);
  });

  it('a failing void leaves the booking AUTHORIZED and a durable payment.void_failed record', async () => {
    const { cancelWithinWindow } = await import('../../lib/bookings');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await seedBooking('AUTHORIZED');
    createdBookingIds.push(bookingId);

    vi.mocked(voidPayment).mockRejectedValueOnce(new Error('simulated 502 from Hyperswitch'));

    const inside = new Date(DEADLINE.getTime() - 60 * 60 * 1000);
    await expect(cancelWithinWindow(bookingId, inside))
      .rejects.toThrow(/simulated 502/);

    // The transaction rolled back — state untouched — but the audit record
    // survives because it was written against the pool, not the transaction.
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.state).toBe('AUTHORIZED');

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    const failure = events.find((e) => e.type === 'payment.void_failed');
    expect(failure).toBeDefined();
    expect(failure!.payload).toMatchObject({ reason: 'dot_24h_cancellation' });
  });
});
