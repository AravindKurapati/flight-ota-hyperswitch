import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { voidPayment } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

/**
 * Flow E: the US DOT 24-hour rule. Inside the window the authorization is
 * voided — the traveller's money was only ever held, never taken (D-002),
 * so cancellation is a release, not a refund.
 */
export async function cancelWithinWindow(
  bookingId: string,
  now: Date = new Date(),
): Promise<{ state: BookingState }> {
  // Set inside the transaction when the Hyperswitch void call itself fails,
  // read after rollback. The audit record for that failure cannot be written
  // while the transaction is still open: the booking row is locked FOR
  // UPDATE, and a pool-connection insert into booking_events blocks on the
  // FK's KEY SHARE lock against that same row — a self-deadlock, since this
  // function would be awaiting the insert while holding the lock it waits on.
  let voidFailure: Error | undefined;

  const run = db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${bookingId}`);

    // Idempotent no-op: cancelling an already-cancelled booking succeeds.
    if (booking.state === 'VOIDED') return { state: booking.state };

    if (booking.state !== 'AUTHORIZED') {
      throw new Error(
        `A booking in state ${booking.state} cannot be cancelled as a void; a captured booking must be refunded`,
      );
    }
    // Server time, deliberately — a client-supplied "now" would let a
    // traveller's clock skew extend the window. `now` is a parameter only so
    // tests can control it.
    if (!booking.voidDeadlineAt || now > booking.voidDeadlineAt) {
      throw new Error('Outside the 24 hour cancellation window');
    }

    const payment = await flightPaymentFor(bookingId, tx);
    assertCapableOrThrow(payment.connector, 'flight');

    try {
      await voidPayment(payment.hsPaymentId, 'dot_24h_cancellation');
    } catch (err) {
      voidFailure = err instanceof Error ? err : new Error(String(err));
      throw err;
    }

    const state = nextState('AUTHORIZED', 'CANCELLED_IN_WINDOW');
    await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
    await tx.update(payments).set({ state: 'cancelled' }).where(eq(payments.id, payment.id));
    await recordEvent(bookingId, 'payment.voided', { reason: 'dot_24h_cancellation' }, tx);

    return { state };
  });

  try {
    return await run;
  } catch (err) {
    if (voidFailure) {
      // Same discipline as the webhook handler's void call (D-019): a
      // transport failure must leave an audit trace, not just an exception.
      // Written here, after the rollback released the row lock, so the
      // record survives the rollback and cannot deadlock against it.
      await recordEvent(bookingId, 'payment.void_failed', {
        reason: 'dot_24h_cancellation',
        error: voidFailure.message,
      }).catch(() => {
        // Best-effort: losing the audit record must not mask the original
        // failure the caller needs to see.
      });
    }
    throw err;
  }
}
