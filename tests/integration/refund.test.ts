// Integration test against the real Neon sandbox database for refundBooking
// (Task 15, flow F): withIdempotency — not the (payment_id, reason) unique
// index — is the primary dedupe; our own refund_id is passed through to
// Hyperswitch; over-refunds are rejected before any Hyperswitch call; and
// the PARTIALLY_REFUNDED self-loop (in the transition table since Task 4,
// untested until now) plus the partial→full path both work.
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured.
// Rows are deleted in afterAll in FK order; the pool is closed so vitest
// exits cleanly.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, refunds, bookingEvents, idempotencyRecords } from '../../db';
import { newId, toHsPaymentId } from '../../lib/ids';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(),
  getPayment: vi.fn(),
  capture: vi.fn(),
  voidPayment: vi.fn(),
  refund: vi.fn(),
}));

const CAPTURED = 35250;

async function seedTicketedBooking() {
  const bookingId = newId();
  const paymentId = newId();
  await db.insert(bookings).values({
    id: bookingId, pnr: `R${Date.now()}${Math.floor(Math.random() * 1000)}`,
    itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
    amountMinor: CAPTURED, state: 'TICKETED', customerId: `cus_${bookingId}`,
    ticketNumber: '016-0000000001',
  });
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'flight', hsPaymentId: toHsPaymentId(paymentId),
    amountMinor: CAPTURED, captureMethod: 'manual', connector: 'authorizedotnet',
    state: 'succeeded',
  });
  return { bookingId, paymentId };
}

describe.skipIf(!hasRealDatabase)('refundBooking (requires a real DATABASE_URL)', () => {
  const createdBookingIds: string[] = [];
  const usedPaymentIds: string[] = [];

  beforeEach(async () => {
    const { refund } = await import('../../lib/hyperswitch');
    vi.mocked(refund).mockReset();
    vi.mocked(refund).mockImplementation(async (input) => ({
      refund_id: input.refundId ?? `ref_generated_${Math.random().toString(36).slice(2)}`,
      payment_id: input.hsPaymentId,
      amount: input.amountMinor,
      status: 'succeeded',
    }));
  });

  afterAll(async () => {
    for (const paymentId of usedPaymentIds) {
      await db.delete(refunds).where(eq(refunds.paymentId, paymentId));
      const keys = await db.select().from(idempotencyRecords);
      for (const k of keys.filter((r) => r.key.startsWith(`refund:${paymentId}:`))) {
        await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, k.key));
      }
    }
    for (const bookingId of createdBookingIds) {
      await db.delete(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
      await db.delete(payments).where(eq(payments.bookingId, bookingId));
      await db.delete(bookings).where(eq(bookings.id, bookingId));
    }
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('a partial refund moves TICKETED to PARTIALLY_REFUNDED and passes our refund_id through', async () => {
    const { refundBooking } = await import('../../lib/bookings');
    const { refund } = await import('../../lib/hyperswitch');
    const { bookingId, paymentId } = await seedTicketedBooking();
    createdBookingIds.push(bookingId);
    usedPaymentIds.push(paymentId);

    const result = await refundBooking({ bookingId, amountMinor: 10000, reason: 'schedule_change' });
    expect(result.state).toBe('PARTIALLY_REFUNDED');

    expect(vi.mocked(refund)).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(refund).mock.calls[0][0];
    expect(sent.refundId).toBeDefined();

    const rows = await db.select().from(refunds).where(eq(refunds.paymentId, paymentId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(sent.refundId);
    expect(rows[0].hsRefundId).toBe(sent.refundId);

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    expect(events.map((e) => e.type)).toContain('refund.created');
  });

  it('the same (booking, reason) refunded twice calls Hyperswitch exactly once — withIdempotency dedupes, not the DB constraint', async () => {
    const { refundBooking } = await import('../../lib/bookings');
    const { refund } = await import('../../lib/hyperswitch');
    const { bookingId, paymentId } = await seedTicketedBooking();
    createdBookingIds.push(bookingId);
    usedPaymentIds.push(paymentId);

    const input = { bookingId, amountMinor: 10000, reason: 'goodwill' };
    const first = await refundBooking(input);
    const second = await refundBooking(input);

    expect(first.state).toBe('PARTIALLY_REFUNDED');
    expect(second.state).toBe('PARTIALLY_REFUNDED');
    // One outbound call and one refunds row: the replay came from the stored
    // idempotency response, it never reached hsRefund or the insert (the DB
    // unique index would have thrown, not deduped — this proves it never fired).
    expect(vi.mocked(refund)).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(refunds).where(eq(refunds.paymentId, paymentId));
    expect(rows).toHaveLength(1);
  });

  it('rejects a refund exceeding the captured amount before any Hyperswitch call', async () => {
    const { refundBooking } = await import('../../lib/bookings');
    const { refund } = await import('../../lib/hyperswitch');
    const { bookingId, paymentId } = await seedTicketedBooking();
    createdBookingIds.push(bookingId);
    usedPaymentIds.push(paymentId);

    await expect(
      refundBooking({ bookingId, amountMinor: CAPTURED + 1, reason: 'too_much' }),
    ).rejects.toThrow(/Refund exceeds captured amount/);
    expect(vi.mocked(refund)).not.toHaveBeenCalled();
  });

  it('successive partial refunds exercise the PARTIALLY_REFUNDED self-loop, then reach REFUNDED at the full amount', async () => {
    const { refundBooking } = await import('../../lib/bookings');
    const { bookingId, paymentId } = await seedTicketedBooking();
    createdBookingIds.push(bookingId);
    usedPaymentIds.push(paymentId);

    const a = await refundBooking({ bookingId, amountMinor: 10000, reason: 'seat_downgrade' });
    expect(a.state).toBe('PARTIALLY_REFUNDED');

    // Task 4's untested self-loop: a second partial refund keeps the booking
    // PARTIALLY_REFUNDED via the REFUNDED_PARTIAL event.
    const b = await refundBooking({ bookingId, amountMinor: 10000, reason: 'meal_missing' });
    expect(b.state).toBe('PARTIALLY_REFUNDED');

    const c = await refundBooking({ bookingId, amountMinor: CAPTURED - 20000, reason: 'goodwill_final' });
    expect(c.state).toBe('REFUNDED');

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.state).toBe('REFUNDED');

    // And once fully refunded, a further refund is refused.
    await expect(
      refundBooking({ bookingId, amountMinor: 1, reason: 'one_more' }),
    ).rejects.toThrow(/Cannot refund a booking in state REFUNDED/);
  });
});
