import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, payments } from '../../db';
import type { Transaction } from '../events';

export type Passenger = { firstName: string; lastName: string };

export const DOT_VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Ambiguous characters (I, O) omitted — PNRs get read aloud over the phone. */
export function pnr(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

/** Every operation that touches money needs the booking's flight payment. */
export async function flightPaymentFor(bookingId: string, tx: Transaction | typeof db = db) {
  const [row] = await tx.select().from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));
  if (!row) throw new Error(`No flight payment for booking ${bookingId}`);
  return row;
}
