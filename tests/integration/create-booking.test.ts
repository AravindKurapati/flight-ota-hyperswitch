// Integration test against the real Neon sandbox database. This is the
// headline test of the whole plan (task-10 brief): two concurrent requests
// must produce exactly one payment row and exactly one outbound Hyperswitch
// call. It is also the first test exercising a real (mocked-transport)
// createBooking flow, so it covers all six task-10 corrections:
//   1. an ambiguous createIntent failure resolves via getPayment read-back
//      before deciding whether anything durable was created (D-013, D-011).
//   3. covered at the route layer (tests/unit/bookings-route.test.ts).
//   4. the mock connector below is authorizedotnet, not stripe (D-012).
//   5. covered by inspection of lib/bookings/create.ts's comment at the
//      point the connector is persisted (no assertion here, deliberately).
//   6. a sequential resubmit (a true replay) must record an
//      idempotent.replay event (SCHEMA.md:150-153).
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured —
// e.g. a clean clone with no .env — so `npm test` stays hermetic. Every row
// this file creates is deleted in afterAll, in FK order (booking_events and
// payments before bookings), and idempotency_records rows are deleted by
// key. The pool is closed so vitest exits without an open-handle warning.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, bookingEvents, idempotencyRecords } from '../../db';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

vi.mock('../../lib/hyperswitch', () => ({
  createIntent: vi.fn(),
  getPayment: vi.fn(),
}));

function freshKey(label: string): string {
  return `idem_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(!hasRealDatabase)('createBooking (requires a real DATABASE_URL)', () => {
  const createdBookingIds: string[] = [];
  const usedKeys: string[] = [];

  beforeEach(async () => {
    const { createIntent, getPayment } = await import('../../lib/hyperswitch');
    vi.mocked(createIntent).mockReset();
    vi.mocked(getPayment).mockReset();
    // Default: createIntent succeeds, routed to authorizedotnet (D-012 —
    // the brief's mock said 'stripe', which is retired per D-012).
    vi.mocked(createIntent).mockImplementation(async (i) => ({
      payment_id: i.hsPaymentId,
      status: 'requires_confirmation',
      connector: 'authorizedotnet',
      client_secret: `${i.hsPaymentId}_secret_test`,
      amount: i.amountMinor,
      amount_capturable: 0,
      amount_received: null,
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
    for (const key of usedKeys) {
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, key));
    }
    // Close the pooled websocket connection so vitest can exit cleanly.
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('creates one booking and one payment, routed to authorizedotnet', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const key = freshKey('create');
    usedKeys.push(key);

    const r = await createBooking({
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: key,
    });
    createdBookingIds.push(r.bookingId);

    expect(r.clientSecret).toContain('_secret_test');
    expect(r.publishableKey).toBe(process.env.HYPERSWITCH_PUBLISHABLE_KEY);

    const rows = await db.select().from(payments).where(eq(payments.bookingId, r.bookingId));
    expect(rows).toHaveLength(1);
    expect(rows[0].hsPaymentId).toHaveLength(30);
    expect(rows[0].connector).toBe('authorizedotnet');
    expect(rows[0].captureMethod).toBe('manual');

    const [booking] = await db.select().from(bookings).where(eq(bookings.id, r.bookingId));
    expect(booking.state).toBe('QUOTED');
  });

  it('a double submit produces one payment and one outbound call', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const { createIntent } = await import('../../lib/hyperswitch');
    const key = freshKey('dbl');
    usedKeys.push(key);

    const payload = {
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: key,
    };

    const [a, b] = await Promise.allSettled([
      createBooking(payload),
      createBooking(payload),
    ]);

    const fulfilled = [a, b].filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createBooking>>> =>
        r.status === 'fulfilled',
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const f of fulfilled) createdBookingIds.push(f.value.bookingId);
    expect(vi.mocked(createIntent)).toHaveBeenCalledTimes(1);

    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.bookingId, fulfilled[0].value.bookingId));
    expect(rows).toHaveLength(1);
  });

  it('a sequential resubmit returns the same client secret and records an idempotent.replay event (correction 6)', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const key = freshKey('seq');
    usedKeys.push(key);
    const payload = {
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: key,
    };
    const first = await createBooking(payload);
    createdBookingIds.push(first.bookingId);
    const second = await createBooking(payload);

    expect(second.clientSecret).toBe(first.clientSecret);
    expect(second.bookingId).toBe(first.bookingId);

    const events = await db
      .select()
      .from(bookingEvents)
      .where(eq(bookingEvents.bookingId, first.bookingId));
    const replayEvents = events.filter((e) => e.type === 'idempotent.replay');
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0].payload).toMatchObject({ idempotencyKey: key });
  });

  it('resolves an ambiguous createIntent failure via read-back, without a second creation attempt (correction 1)', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const { createIntent, getPayment } = await import('../../lib/hyperswitch');
    const key = freshKey('ambiguous');
    usedKeys.push(key);

    vi.mocked(createIntent).mockRejectedValueOnce(
      new Error('simulated transport failure after Hyperswitch may have already created the payment'),
    );
    vi.mocked(getPayment).mockImplementationOnce(async (id: string) => ({
      payment_id: id,
      status: 'requires_confirmation',
      connector: 'authorizedotnet',
      client_secret: `${id}_secret_test`,
      amount: 35250,
      amount_capturable: 0,
      amount_received: null,
      payment_method_id: null,
      error_message: null,
      error_code: null,
    }));

    const r = await createBooking({
      itineraryId: 'itin_sfo_jfk',
      passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
      idempotencyKey: key,
    });
    createdBookingIds.push(r.bookingId);

    expect(r.clientSecret).toContain('_secret_test');
    expect(vi.mocked(createIntent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getPayment)).toHaveBeenCalledTimes(1);

    const rows = await db.select().from(payments).where(eq(payments.bookingId, r.bookingId));
    expect(rows).toHaveLength(1);

    // The idempotency record must be complete, not left in_flight or
    // deleted: fn() succeeded (via the read-back), so withIdempotency's
    // contract (D-013) says the key must never be released here.
    const [record] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key));
    expect(record.status).toBe('complete');
  });

  it('rejects an unknown itinerary before claiming the idempotency key, leaving no orphaned record', async () => {
    const { createBooking } = await import('../../lib/bookings');
    const key = freshKey('unknown_itin');

    await expect(
      createBooking({
        itineraryId: 'itin_does_not_exist',
        passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/Unknown itinerary/);

    const [record] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key));
    expect(record).toBeUndefined();
  });
});
