// Integration test against the real Neon sandbox database for
// chargeAncillary (Task 18, flow H — the highest-risk task in this batch:
// off-session MIT charging via withIdempotency, needing the exact
// ambiguous-failure treatment createIntentOrReadBack established in Task 10).
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured.
// Rows are deleted in afterAll in FK order; the pool is closed so vitest
// exits cleanly.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, bookingEvents, idempotencyRecords } from '../../db';
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
  createAndConfirmDummyCharge: vi.fn(),
  chargeOffSession: vi.fn(),
}));

function hsPaymentOf(id: string, amount: number) {
  return {
    payment_id: id, status: 'succeeded', connector: 'authorizedotnet',
    client_secret: null, amount, amount_capturable: 0, amount_received: amount,
    payment_method_id: 'pm_stored_test', error_message: null, error_code: null,
  };
}

async function seedTicketedBooking(withPaymentMethod: boolean) {
  const bookingId = newId();
  const paymentId = newId();
  await db.insert(bookings).values({
    id: bookingId, pnr: `A${Date.now()}${Math.floor(Math.random() * 1000)}`,
    itineraryId: 'itin_sfo_jfk', passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
    amountMinor: 35250, state: 'TICKETED', customerId: `cus_${bookingId}`,
    ticketNumber: '016-0000000002',
    paymentMethodId: withPaymentMethod ? 'pm_stored_test' : null,
  });
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'flight', hsPaymentId: toHsPaymentId(paymentId),
    amountMinor: 35250, captureMethod: 'manual', connector: 'authorizedotnet',
    state: 'succeeded',
  });
  return bookingId;
}

function freshKey(label: string): string {
  return `idem_anc_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(!hasRealDatabase)('chargeAncillary (requires a real DATABASE_URL)', () => {
  const createdBookingIds: string[] = [];
  const usedKeys: string[] = [];

  beforeEach(async () => {
    const { chargeOffSession, getPayment } = await import('../../lib/hyperswitch');
    vi.mocked(chargeOffSession).mockReset();
    vi.mocked(getPayment).mockReset();
    vi.mocked(chargeOffSession).mockImplementation(async (input) =>
      hsPaymentOf(input.hsPaymentId, input.amountMinor));
  });

  afterAll(async () => {
    for (const bookingId of createdBookingIds) {
      await db.delete(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
      await db.delete(payments).where(eq(payments.bookingId, bookingId));
      await db.delete(bookings).where(eq(bookings.id, bookingId));
    }
    for (const key of usedKeys) {
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, key));
    }
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('refuses when no payment method was saved at checkout', async () => {
    const { chargeAncillary } = await import('../../lib/bookings');
    const { chargeOffSession } = await import('../../lib/hyperswitch');
    const bookingId = await seedTicketedBooking(false);
    createdBookingIds.push(bookingId);
    const key = freshKey('nopm');
    usedKeys.push(key);

    await expect(chargeAncillary({
      bookingId, description: 'Extra bag', amountMinor: 4500, idempotencyKey: key,
    })).rejects.toThrow(/No stored payment method/);
    expect(vi.mocked(chargeOffSession)).not.toHaveBeenCalled();
  });

  it('charges off-session against the stored payment method and records ancillary.charged', async () => {
    const { chargeAncillary } = await import('../../lib/bookings');
    const { chargeOffSession } = await import('../../lib/hyperswitch');
    const bookingId = await seedTicketedBooking(true);
    createdBookingIds.push(bookingId);
    const key = freshKey('ok');
    usedKeys.push(key);

    const result = await chargeAncillary({
      bookingId, description: 'Extra bag', amountMinor: 4500, idempotencyKey: key,
    });
    expect(result.status).toBe('succeeded');

    expect(vi.mocked(chargeOffSession)).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(chargeOffSession).mock.calls[0][0];
    expect(sent.paymentMethodId).toBe('pm_stored_test');

    const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    const ancillary = rows.find((r) => r.kind === 'ancillary');
    expect(ancillary).toBeDefined();
    expect(ancillary!.state).toBe('succeeded');
    expect(ancillary!.connector).toBe('authorizedotnet');

    const events = await db.select().from(bookingEvents)
      .where(eq(bookingEvents.bookingId, bookingId));
    expect(events.map((e) => e.type)).toContain('ancillary.charged');
  });

  it('the same idempotency key charged twice produces exactly one outbound charge', async () => {
    const { chargeAncillary } = await import('../../lib/bookings');
    const { chargeOffSession } = await import('../../lib/hyperswitch');
    const bookingId = await seedTicketedBooking(true);
    createdBookingIds.push(bookingId);
    const key = freshKey('dbl');
    usedKeys.push(key);

    const input = { bookingId, description: 'Seat selection', amountMinor: 2900, idempotencyKey: key };
    const first = await chargeAncillary(input);
    const second = await chargeAncillary(input);

    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(vi.mocked(chargeOffSession)).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(payments).where(eq(payments.bookingId, bookingId));
    expect(rows.filter((r) => r.kind === 'ancillary')).toHaveLength(1);
  });

  it('resolves an ambiguous chargeOffSession failure via read-back without a second charge attempt', async () => {
    const { chargeAncillary } = await import('../../lib/bookings');
    const { chargeOffSession, getPayment } = await import('../../lib/hyperswitch');
    const bookingId = await seedTicketedBooking(true);
    createdBookingIds.push(bookingId);
    const key = freshKey('ambig');
    usedKeys.push(key);

    vi.mocked(chargeOffSession).mockRejectedValueOnce(
      new Error('simulated transport failure after Hyperswitch may have already charged'),
    );
    vi.mocked(getPayment).mockImplementationOnce(async (id: string) => hsPaymentOf(id, 4500));

    const result = await chargeAncillary({
      bookingId, description: 'Change fee', amountMinor: 4500, idempotencyKey: key,
    });
    expect(result.status).toBe('succeeded');
    expect(vi.mocked(chargeOffSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getPayment)).toHaveBeenCalledTimes(1);

    // fn() succeeded via the read-back, so the idempotency key must be
    // complete — never released (withIdempotency's contract, D-013).
    const [record] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key));
    expect(record.status).toBe('complete');
  });
});
