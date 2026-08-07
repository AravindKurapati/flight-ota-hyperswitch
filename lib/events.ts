import 'server-only';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NeonQueryResultHKT } from 'drizzle-orm/neon-serverless';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db, bookingEvents } from '../db';
import * as schema from '../db/schema';

// The exact type of the `tx` argument `db.transaction(async (tx) => ...)`
// hands its callback. This is NOT `typeof db` (task-8 correction 5): `db` is
// a `NeonDatabase`, a transaction is a `NeonTransaction`, and the two are
// different classes that merely share a common base. Typing the parameter
// this way is what lets a real caller pass its open transaction and have
// recordEvent's insert genuinely participate in it — the entire point of
// the parameter, since the event log and the state change it documents must
// commit or roll back together.
export type Transaction = PgTransaction<
  NeonQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Append an entry to the `booking_events` audit log. Never updated, never
 * deleted — `booking_events.id` is `GENERATED ALWAYS AS IDENTITY` specifically
 * so a caller cannot supply its own sequence number.
 *
 * Pass `tx` (a transaction handed to you by `db.transaction(...)`) whenever
 * this event must commit atomically with a state change; omit it to write
 * against the pool directly.
 */
export async function recordEvent(
  bookingId: string,
  type: string,
  payload: unknown = {},
  tx: Transaction | typeof db = db,
): Promise<void> {
  await tx.insert(bookingEvents).values({
    bookingId,
    type,
    payload: payload as Record<string, unknown>,
  });
}
