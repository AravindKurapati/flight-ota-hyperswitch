// Integration test against the real Neon sandbox database for issueTicket
// (Task 13, flows C and D): capture never precedes ticket issuance, terminal
// issuance failures void instead of capturing, and a repeat call on a
// TICKETED booking short-circuits rather than capturing twice.
//
// Hyperswitch transport is mocked; the ticketing simulation is real, so the
// deterministic itineraries drive each scenario: itin_sfo_jfk always issues,
// itin_bos_sea always fails terminally.
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured —
// e.g. a clean clone with no .env — so `npm test` stays hermetic. Every row
// this file inserts is deleted in afterAll in FK order, and the pool is
// closed so vitest exits without an open-handle warning.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, bookingEvents } from '../../db';
import { newId, toHsPaymentId } from '../../lib/ids';
import { resetIssuanceCounters } from '../../lib/ticketing';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(),
  getPayment: vi.fn(),
  capture: vi.fn(),
  voidPayment: vi.fn(),
}));

async function seedAuthorizedBooking(itineraryId: string, state = 'AUTHORIZED' as const) {
  const bookingId = newId();
  const paymentId = newId();
  const hsPaymentId = toHsPaymentId(paymentId);
  await db.insert(bookings).values({
    id: bookingId, pnr: `I${Date.now()}${Math.floor(Math.random() * 1000)}`,
    itineraryId, passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
    amountMinor: 65400, state, customerId: `cus_${bookingId}`,
    voidDeadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'flight', hsPaymentId, amountMinor: 65400,
    captureMethod: 'manual', connector: 'authorizedotnet', state: 'requires_capture',
  });
  return { bookingId, paymentId, hsPaymentId };
}

describe.skipIf(!hasRealDatabase)('issueTicket (requires a real DATABASE_URL)', () => {
  const createdBookingIds: string[] = [];

  beforeEach(async () => {
    const { capture, voidPayment } = await import('../../lib/hyperswitch');
    vi.mocked(capture).mockReset();
    vi.mocked(voidPayment).mockReset();
    vi.mocked(capture).mockImplementation(async (id: string) => ({
      payment_id: id, status: 'succeeded', connector: 'authorizedotnet',
      client_secret: null, amount: 65400, amount_capturable: 0,
      amount_received: 65400, payment_method_id: null,
      error_message: null, error_code: null,
    }));
    vi.mocked(voidPayment).mockImplementation(async (id: string) => ({
      payment_id: id, status: 'cancelled', connector: 'authorizedotnet',
      client_secret: null, amount: 65400, amount_capturable: 0,
      amount_received: null, payment_method_id: null,
      error_message: null, error_code: null,
    }));
    resetIssuanceCounters();
  });

  afterAll(async () => {
    for (const bookingId of createdBookingIds) {
      await db.delete(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
      await db.delete(payments).where(eq(payments.bookingId, bookingId));
      await db.delete(bookings).where(eq(bookings.id, bookingId));
    }
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('captures only after a ticket number exists, and records both events', async () => {
    const { issueTicket } = await import('../../lib/bookings');
    const { capture } = await import('../../lib/hyperswitch');
    const { bookingId, hsPaymentId } = await seedAuthorizedBooking('itin_sfo_jfk');
    createdBookingIds.push(bookingId);

    const result = await issueTicket(bookingId);
    expect(result.state).toBe('TICKETED');
    expect(result.ticketNumber).toMatch(/^016-\d{10}$/);
    expect(vi.mocked(capture)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(capture)).toHaveBeenCalledWith(hsPaymentId, 65400);

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.state).toBe('TICKETED');
    expect(booking.ticketNumber).toBe(result.ticketNumber);

    const [payment] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    expect(payment.state).toBe('succeeded');

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    const types = events.map((e) => e.type);
    expect(types).toContain('ticketing.attempted');
    expect(types).toContain('ticketing.succeeded');
    expect(types).toContain('payment.captured');
  });

  it('voids on a terminal issuance failure and never captures', async () => {
    const { issueTicket } = await import('../../lib/bookings');
    const { capture, voidPayment } = await import('../../lib/hyperswitch');
    const { bookingId, hsPaymentId } = await seedAuthorizedBooking('itin_bos_sea');
    createdBookingIds.push(bookingId);

    const result = await issueTicket(bookingId);
    expect(result.state).toBe('VOIDED');
    expect(result.ticketNumber).toBeUndefined();
    expect(vi.mocked(capture)).not.toHaveBeenCalled();
    expect(vi.mocked(voidPayment)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(voidPayment).mock.calls[0][0]).toBe(hsPaymentId);

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking.state).toBe('VOIDED');

    const [payment] = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    expect(payment.state).toBe('cancelled');

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    expect(events.map((e) => e.type)).toContain('payment.voided');
  });

  it('a second call on a TICKETED booking short-circuits without a second capture', async () => {
    const { issueTicket } = await import('../../lib/bookings');
    const { capture } = await import('../../lib/hyperswitch');
    const { bookingId } = await seedAuthorizedBooking('itin_sfo_jfk');
    createdBookingIds.push(bookingId);

    const first = await issueTicket(bookingId);
    const second = await issueTicket(bookingId);

    expect(second.state).toBe('TICKETED');
    expect(second.ticketNumber).toBe(first.ticketNumber);
    expect(vi.mocked(capture)).toHaveBeenCalledTimes(1);
  });

  it('rejects a booking that was never authorized with a clean error', async () => {
    const { issueTicket } = await import('../../lib/bookings');
    const { bookingId } = await seedAuthorizedBooking('itin_sfo_jfk', 'QUOTED' as never);
    createdBookingIds.push(bookingId);

    await expect(issueTicket(bookingId))
      .rejects.toThrow(/Cannot issue a ticket for a booking in state QUOTED/);
  });
});
