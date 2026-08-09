// Integration test against the real Neon sandbox database. Proves
// recordEvent (task 8) actually behaves as the append-only audit log
// booking_events is meant to be: writes are readable back, the identity
// column rejects a caller-supplied id, and — the reason recordEvent takes a
// `tx` parameter at all — a write inside a caller's transaction rolls back
// with it.
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured —
// e.g. a clean clone with no .env — so `npm test` stays hermetic. Every row
// this file creates is deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, bookings, bookingEvents } from '../../db';
import { newId } from '../../lib/ids';
import { recordEvent } from '../../lib/events';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

describe.skipIf(!hasRealDatabase)('recordEvent (requires a real DATABASE_URL)', () => {
  let bookingId: string;

  beforeAll(async () => {
    bookingId = newId();
    await db.insert(bookings).values({
      id: bookingId, pnr: `EVT${Date.now()}`, itineraryId: 'itin_1',
      passengers: [], amountMinor: 65400,
    });
  });

  afterAll(async () => {
    await db.delete(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    await db.delete(bookings).where(eq(bookings.id, bookingId));
    // Close the pooled websocket connection so vitest can exit cleanly.
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('persists an event that is readable back, with an identity-assigned id', async () => {
    await recordEvent(bookingId, 'booking.created', { foo: 'bar' });

    const rows = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    const match = rows.find((r) => r.type === 'booking.created');

    expect(match).toBeDefined();
    expect(match?.payload).toEqual({ foo: 'bar' });
    expect(typeof match?.id).toBe('number');
    expect(match?.createdAt).toBeInstanceOf(Date);
  });

  it('defaults payload to {} when omitted', async () => {
    await recordEvent(bookingId, 'test.no_payload');
    const rows = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    const match = rows.find((r) => r.type === 'test.no_payload');
    expect(match?.payload).toEqual({});
  });

  it('rejects a caller-supplied id on the GENERATED ALWAYS AS IDENTITY column', async () => {
    // Deliberately bypasses the insert type (which drizzle-orm's
    // `generatedAlwaysAsIdentity()` should keep `id` out of) to prove this
    // is enforced by Postgres, not merely by the TypeScript surface — a
    // caller reaching the table through raw SQL or a future refactor must
    // still be stopped at the database.
    const insertWithId = db.insert(bookingEvents).values({
      id: 999999999,
      bookingId,
      type: 'test.forged_id',
      payload: {},
    } as unknown as typeof bookingEvents.$inferInsert);

    await expect(insertWithId).rejects.toThrow();
  });

  it('rolls back its event write when the caller transaction rolls back', async () => {
    const before = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));

    await expect(
      db.transaction(async (tx) => {
        await recordEvent(bookingId, 'test.tx_rollback', { x: 1 }, tx);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const after = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    expect(after.length).toBe(before.length);
    expect(after.some((r) => r.type === 'test.tx_rollback')).toBe(false);
  });

  it('commits its event write when the caller transaction commits', async () => {
    await db.transaction(async (tx) => {
      await recordEvent(bookingId, 'test.tx_commit', { y: 2 }, tx);
    });

    const rows = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
    expect(rows.some((r) => r.type === 'test.tx_commit')).toBe(true);
  });
});
