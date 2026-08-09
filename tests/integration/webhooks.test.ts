// Integration test against the real Neon sandbox database (task-12
// correction 3). Exercises POST /api/webhooks/hyperswitch as an actual
// route, against a real `payments` row, proving three things a pure unit
// test on verifySignature cannot:
//   1. req.text() on this Next.js App Router route handler yields the exact
//      raw bytes HMAC verification needs (also covered, without a database,
//      in tests/unit/webhooks.test.ts).
//   2. a correctly-signed body actually mutates the row and the mutation is
//      readable back -- not just that the route returns 200.
//   3. a tampered signature changes nothing in the database, not just that
//      it returns 401.
//
// Also covers task-12 correction 1 (D-007 finally wired here): a webhook
// reporting a connector that cannot support the payment's kind is voided
// and recorded as a `capability.violation` event, and the undefined-vs-null
// distinction on the `connector` field is exercised directly, since that
// distinction is the crux of the correction.
//
// `lib/hyperswitch` is mocked so no real call reaches the Hyperswitch
// sandbox for the void path -- this test is about our own state and event
// log, not about exercising voidPayment itself (that's tests/unit/hyperswitch.test.ts).
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured --
// e.g. a clean clone with no .env -- so `npm test` stays hermetic. Every row
// this file creates is deleted in afterAll, in FK order (booking_events and
// payments before bookings), and the pool is closed so vitest exits without
// an open-handle warning.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, bookingEvents } from '../../db';
import { newId, toHsPaymentId } from '../../lib/ids';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

vi.mock('../../lib/hyperswitch', () => ({
  voidPayment: vi.fn(),
}));

const secret = process.env.HYPERSWITCH_WEBHOOK_SECRET!;

function sign(body: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

function webhookRequest(body: string, signature: string): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/hyperswitch', {
    method: 'POST',
    body,
    headers: signature ? { 'x-webhook-signature-512': signature } : {},
  });
}

function payload(hsPaymentId: string, status: string, connector?: string | null) {
  const object: Record<string, unknown> = { payment_id: hsPaymentId, status };
  // Only set the key at all when the caller wants it present -- mirrors
  // Correction 1's undefined-vs-null distinction: omitting this assignment
  // entirely (vs. setting it to null) is what produces a genuinely absent
  // field in the JSON, not a `"connector": null` field.
  if (connector !== undefined) object.connector = connector;
  return JSON.stringify({ event_id: `evt_${Date.now()}`, content: { object } });
}

describe.skipIf(!hasRealDatabase)('POST /api/webhooks/hyperswitch (requires a real DATABASE_URL)', () => {
  const bookingIds: string[] = [];
  const paymentIds: string[] = [];

  async function makeBooking(): Promise<string> {
    const bookingId = newId();
    bookingIds.push(bookingId);
    await db.insert(bookings).values({
      id: bookingId, pnr: `WH${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      itineraryId: 'itin_1', passengers: [], amountMinor: 65400,
    });
    return bookingId;
  }

  async function makePayment(
    bookingId: string,
    opts: { kind: 'flight' | 'protection' | 'ancillary'; state: string; connector?: string | null },
  ): Promise<{ id: string; hsPaymentId: string }> {
    const id = newId();
    paymentIds.push(id);
    const hsPaymentId = toHsPaymentId(id);
    await db.insert(payments).values({
      id, bookingId, kind: opts.kind, hsPaymentId,
      amountMinor: 65400, captureMethod: opts.kind === 'flight' ? 'manual' : 'automatic',
      connector: opts.connector ?? null, state: opts.state,
    });
    return { id, hsPaymentId };
  }

  beforeEach(async () => {
    const { voidPayment } = await import('../../lib/hyperswitch');
    vi.mocked(voidPayment).mockReset();
    vi.mocked(voidPayment).mockResolvedValue({
      payment_id: 'unused', status: 'cancelled', connector: 'fauxpay',
      client_secret: null, amount: 65400, amount_capturable: 0, amount_received: null,
      payment_method_id: null, error_message: null, error_code: null,
    });
  });

  afterAll(async () => {
    for (const bookingId of bookingIds) {
      await db.delete(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    }
    for (const id of paymentIds) {
      await db.delete(payments).where(eq(payments.id, id));
    }
    for (const bookingId of bookingIds) {
      await db.delete(bookings).where(eq(bookings.id, bookingId));
    }
    // Close the pooled websocket connection so vitest can exit cleanly.
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('applies a monotonic state advance and persists connector on a correctly-signed payload', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    const body = payload(hsPaymentId, 'requires_capture', 'authorizedotnet');
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('requires_capture');
    expect(row.connector).toBe('authorizedotnet');

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    expect(events.some((e) => e.type === 'webhook.received')).toBe(true);
  });

  it('a tampered signature results in 401 and no state change', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    const body = payload(hsPaymentId, 'succeeded', 'authorizedotnet');
    const tampered = payload(hsPaymentId, 'cancelled', 'authorizedotnet');
    // Sign the original body, then send a different one -- the signature no
    // longer matches what was actually delivered.
    const res = await POST(webhookRequest(tampered, sign(body)));
    expect(res.status).toBe(401);

    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('requires_confirmation');
    expect(row.connector).toBeNull();
  });

  it('never regresses state: a late lower-rank status after a higher one is a no-op', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'protection', state: 'succeeded', connector: 'fauxpay',
    });

    // 'requires_capture' (rank 4) arriving after 'succeeded' (rank 6) is a
    // stale/out-of-order delivery and must not move the row backwards.
    const body = payload(hsPaymentId, 'requires_capture', 'fauxpay');
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('succeeded');
  });

  it('correction 1: skips the capability check and does not overwrite connector when the field is genuinely absent', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await makeBooking();
    // A flight payment with connector already null would fail
    // assertCapableOrThrow(null, 'flight') if the check ran -- proving the
    // check is genuinely skipped, not accidentally passing.
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    const body = payload(hsPaymentId, 'requires_capture'); // no `connector` key at all
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    expect(voidPayment).not.toHaveBeenCalled();
    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('requires_capture'); // normal advance still happened
    expect(row.connector).toBeNull(); // untouched, not overwritten

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    expect(events.some((e) => e.type === 'capability.violation')).toBe(false);
  });

  it('correction 1: a genuinely null connector on a flight payment IS checked (null is meaningful, not "absent")', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    const body = payload(hsPaymentId, 'requires_capture', null); // explicit connector: null
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    expect(voidPayment).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('cancelled');

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    const violation = events.find((e) => e.type === 'capability.violation');
    expect(violation).toBeDefined();
    expect(violation?.payload).toMatchObject({ connector: null, kind: 'flight', voided: true });
    expect((violation?.payload as { missing: string[] }).missing).toEqual(
      expect.arrayContaining(['capture', 'void']),
    );
  });

  it('correction 1: a flight payment reported on an incapable connector is voided and recorded, still 200', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    // fauxpay cannot capture or void (D-007) -- illegal for a flight kind.
    const body = payload(hsPaymentId, 'requires_capture', 'fauxpay');
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    expect(voidPayment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(voidPayment).mock.calls[0][0]).toBe(hsPaymentId);

    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('cancelled'); // the mocked voidPayment's returned status
    expect(row.connector).toBe('fauxpay'); // persisted truthfully even though it's the bad one

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    const violation = events.find((e) => e.type === 'capability.violation');
    expect(violation).toBeDefined();
    expect(violation?.payload).toMatchObject({ connector: 'fauxpay', kind: 'flight', voided: true });
    expect((violation?.payload as { reason: string }).reason).toContain('capture');
    expect((violation?.payload as { missing: string[] }).missing).toEqual(
      expect.arrayContaining(['capture', 'void']),
    );
    expect(events.some((e) => e.type === 'webhook.received')).toBe(true);
  });

  it('review fix 1: a voidPayment failure still records the violation event (voided: false, voidError set) and still returns 200', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const { voidPayment } = await import('../../lib/hyperswitch');
    vi.mocked(voidPayment).mockRejectedValueOnce(new Error('simulated network failure calling Hyperswitch'));

    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    const body = payload(hsPaymentId, 'requires_capture', 'fauxpay');
    const res = await POST(webhookRequest(body, sign(body)));

    // The void call blew up, but the handler must not crash or surface an
    // unhandled rejection -- it still acks the delivery.
    expect(res.status).toBe(200);
    const bodyJson = await res.json();
    expect(bodyJson).toEqual({ ok: true });

    expect(voidPayment).toHaveBeenCalledTimes(1);

    // No successful void result exists to read a new state from, so the
    // payment row's state is left exactly as it was.
    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('requires_confirmation');
    // The connector value is still worth persisting truthfully even though
    // the void itself failed.
    expect(row.connector).toBe('fauxpay');

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    const violation = events.find((e) => e.type === 'capability.violation');
    expect(violation).toBeDefined();
    expect(violation?.payload).toMatchObject({
      connector: 'fauxpay', kind: 'flight', voided: false,
      voidError: 'simulated network failure calling Hyperswitch',
    });
    expect(events.some((e) => e.type === 'webhook.received')).toBe(true);
  });

  it("correction 1: a duplicate delivery of the same violation doesn't double-void", async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const { voidPayment } = await import('../../lib/hyperswitch');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_confirmation', connector: null,
    });

    const body = payload(hsPaymentId, 'requires_capture', 'fauxpay');
    const signature = sign(body);

    const first = await POST(webhookRequest(body, signature));
    expect(first.status).toBe(200);
    const second = await POST(webhookRequest(body, signature));
    expect(second.status).toBe(200);

    // The row was already 'cancelled' (rank >= terminal) by the time the
    // second delivery ran its capability check, so voidPayment must only
    // have been called once.
    expect(voidPayment).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('cancelled');

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    const violations = events.filter((e) => e.type === 'capability.violation');
    expect(violations).toHaveLength(2); // both deliveries are still recorded...
    expect(violations[1].payload).toMatchObject({ voided: false }); // ...but only the first actually voided
  });

  it('review fix 3: a previously-set real connector survives a later webhook that omits the field', async () => {
    // The scenario correction 4 actually exists to prevent: NOT a row that
    // starts null and stays null (that was the original, weaker test below),
    // but a row that already holds a real, working connector value and must
    // not have it silently nulled out by a later delivery that simply
    // doesn't carry the field.
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const bookingId = await makeBooking();
    const { hsPaymentId, id } = await makePayment(bookingId, {
      kind: 'flight', state: 'requires_capture', connector: 'authorizedotnet',
    });

    const body = payload(hsPaymentId, 'succeeded'); // no `connector` key at all
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    expect(row.state).toBe('succeeded'); // normal advance still happened
    expect(row.connector).toBe('authorizedotnet'); // NOT nulled out
  });

  it('acknowledges an unknown payment_id with 200 and writes nothing', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const body = payload(toHsPaymentId(newId()), 'succeeded', 'authorizedotnet');
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);
    const bodyJson = await res.json();
    expect(bodyJson).toEqual({ ok: true });
  });
});
