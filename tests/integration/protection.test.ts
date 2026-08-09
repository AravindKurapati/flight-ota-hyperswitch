// Integration test against the real Neon sandbox database for
// addTripProtection (Task 17, flow G): the $24 add-on lands on fauxpay with
// an immediate `succeeded` (mocked transport), a second call for the same
// booking is rejected by the (booking_id, kind) partial unique index before
// any money moves, and the insert-before-charge ordering means an insert
// failure leaves no orphaned Hyperswitch charge by construction.
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured.
// Rows are deleted in afterAll in FK order; the pool is closed so vitest
// exits cleanly.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, bookingEvents } from '../../db';
import { newId } from '../../lib/ids';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(),
  getPayment: vi.fn(),
  capture: vi.fn(),
  voidPayment: vi.fn(),
  refund: vi.fn(),
  createAndConfirmDummyCharge: vi.fn(),
}));

async function seedBooking() {
  const bookingId = newId();
  await db.insert(bookings).values({
    id: bookingId, pnr: `P${Date.now()}${Math.floor(Math.random() * 1000)}`,
    itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
    amountMinor: 35250, state: 'QUOTED', customerId: `cus_${bookingId}`,
  });
  return bookingId;
}

describe.skipIf(!hasRealDatabase)('addTripProtection (requires a real DATABASE_URL)', () => {
  const createdBookingIds: string[] = [];

  beforeEach(async () => {
    const { createAndConfirmDummyCharge } = await import('../../lib/hyperswitch');
    vi.mocked(createAndConfirmDummyCharge).mockReset();
    vi.mocked(createAndConfirmDummyCharge).mockImplementation(async (input) => ({
      payment_id: input.hsPaymentId,
      status: 'succeeded',
      connector: 'fauxpay',
      client_secret: null,
      amount: input.amountMinor,
      amount_capturable: 0,
      amount_received: input.amountMinor,
      payment_method_id: null,
      error_message: null,
      error_code: null,
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

  it('charges $24.00 on fauxpay with an immediate succeeded, and records protection.added', async () => {
    const { addTripProtection } = await import('../../lib/bookings');
    const { createAndConfirmDummyCharge } = await import('../../lib/hyperswitch');
    const bookingId = await seedBooking();
    createdBookingIds.push(bookingId);

    const result = await addTripProtection(bookingId);
    expect(result.connector).toBe('fauxpay');
    expect(vi.mocked(createAndConfirmDummyCharge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAndConfirmDummyCharge).mock.calls[0][0].amountMinor).toBe(2400);

    const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('protection');
    expect(rows[0].state).toBe('succeeded');
    expect(rows[0].connector).toBe('fauxpay');
    expect(rows[0].captureMethod).toBe('automatic');

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    expect(events.map((e) => e.type)).toContain('protection.added');
  });

  it('rejects a second protection charge for the same booking before any money moves', async () => {
    const { addTripProtection } = await import('../../lib/bookings');
    const { createAndConfirmDummyCharge } = await import('../../lib/hyperswitch');
    const bookingId = await seedBooking();
    createdBookingIds.push(bookingId);

    await addTripProtection(bookingId);
    // The (booking_id, kind) partial unique index fires on the insert, which
    // happens BEFORE the charge — so the second Hyperswitch call never goes out.
    await expect(addTripProtection(bookingId)).rejects.toThrow();
    expect(vi.mocked(createAndConfirmDummyCharge)).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    expect(rows).toHaveLength(1);
  });

  it('an unknown booking is rejected with no insert and no charge', async () => {
    const { addTripProtection } = await import('../../lib/bookings');
    const { createAndConfirmDummyCharge } = await import('../../lib/hyperswitch');

    await expect(addTripProtection('does-not-exist')).rejects.toThrow(/Unknown booking/);
    expect(vi.mocked(createAndConfirmDummyCharge)).not.toHaveBeenCalled();
  });
});
