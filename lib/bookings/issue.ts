import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { attemptIssuance } from '../ticketing';
import { capture, voidPayment } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

/**
 * Flows C and D: attempt to issue a ticket for an AUTHORIZED (or retrying
 * TICKETING) booking, and only capture the traveller's money once a ticket
 * number actually exists (D-002). A terminal issuance failure voids the
 * authorization instead — the traveller is never charged for a seat that
 * will never exist (D-004).
 *
 * Residual risk, accepted (D-020): if `capture` throws ambiguously *after*
 * Hyperswitch has actually captured — a timeout, a dropped connection — this
 * transaction rolls back and a retry re-runs `attemptIssuance` and calls
 * `capture` again on a possibly-already-captured payment. Whether
 * Hyperswitch's capture endpoint is idempotent for that case is unverified.
 * The ops console (Task 16), which shows stored vs. live payment state side
 * by side, is the detection mechanism; there is no automatic fix.
 */
export async function issueTicket(
  bookingId: string,
): Promise<{ state: BookingState; ticketNumber?: string }> {
  return db.transaction(async (tx) => {
    const [booking] = await tx.select().from(bookings)
      .where(eq(bookings.id, bookingId)).for('update');
    if (!booking) throw new Error(`Unknown booking ${bookingId}`);

    // Idempotency: the row lock above serializes concurrent calls; a second
    // caller re-reads booking.state after the first commits and
    // short-circuits here rather than capturing twice. This does the same
    // job withIdempotency does elsewhere, but keyed on the booking's own
    // state instead of a caller-supplied key — appropriate here because
    // issueTicket takes no input besides bookingId, so the booking row *is*
    // the natural key.
    if (booking.state === 'TICKETED') {
      return { state: booking.state, ticketNumber: booking.ticketNumber ?? undefined };
    }
    if (booking.state !== 'AUTHORIZED' && booking.state !== 'TICKETING') {
      throw new Error(`Cannot issue a ticket for a booking in state ${booking.state}`);
    }

    const payment = await flightPaymentFor(bookingId, tx);

    // D-007: refuse to proceed on a connector that cannot capture or void
    // this payment. Should never fire given the routing rules (D-005/D-006),
    // but this is the enforcement, not a formality.
    assertCapableOrThrow(payment.connector, 'flight');

    if (booking.state === 'AUTHORIZED') {
      const state = nextState('AUTHORIZED', 'ISSUANCE_STARTED');
      await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
      await recordEvent(bookingId, 'ticketing.attempted', {}, tx);
    }

    const issuance = await attemptIssuance(booking.itineraryId, bookingId);

    if (!issuance.ok && issuance.kind === 'retryable') {
      // Explicit self-loop through the state machine rather than an implicit
      // early return, so every transition — including no-ops — goes through
      // one auditable path.
      const state = nextState('TICKETING', 'ISSUANCE_FAILED_RETRYABLE');
      await recordEvent(bookingId, 'ticketing.failed', { kind: 'retryable', reason: issuance.reason }, tx);
      return { state };
    }

    if (!issuance.ok) {
      // Terminal failure. Void — the traveller is never charged for a seat
      // that will never exist (D-004).
      await voidPayment(payment.hsPaymentId, issuance.reason);
      const state = nextState('TICKETING', 'ISSUANCE_FAILED_TERMINAL');
      await tx.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
      await tx.update(payments).set({ state: 'cancelled' }).where(eq(payments.id, payment.id));
      await recordEvent(bookingId, 'ticketing.failed', { kind: 'terminal', reason: issuance.reason }, tx);
      await recordEvent(bookingId, 'payment.voided', { reason: issuance.reason }, tx);
      return { state };
    }

    // Ticket exists. Only now do we take the money (D-002's whole point).
    await capture(payment.hsPaymentId, payment.amountMinor);
    const state = nextState('TICKETING', 'ISSUANCE_SUCCEEDED');
    await tx.update(bookings)
      .set({ state, ticketNumber: issuance.ticketNumber, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
    await tx.update(payments).set({ state: 'succeeded' }).where(eq(payments.id, payment.id));
    // Both events, deliberately: a ticket existing and money moving are
    // different facts (SCHEMA.md lists both types).
    await recordEvent(bookingId, 'ticketing.succeeded', { ticketNumber: issuance.ticketNumber }, tx);
    await recordEvent(bookingId, 'payment.captured', { ticketNumber: issuance.ticketNumber }, tx);

    return { state, ticketNumber: issuance.ticketNumber };
  });
}
