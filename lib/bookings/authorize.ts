import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { getPayment } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

/**
 * Advances a QUOTED booking to AUTHORIZED once its flight payment has
 * actually been authorized at Hyperswitch (D-023). The source of truth is a
 * live `getPayment` read, never our own stored `payments.state` — that
 * column was last written at create-intent time and D-011 says ambiguity
 * resolves by reading.
 *
 * This is the QUOTED → AUTH_SUCCEEDED transition's only caller. The webhook
 * handler (Task 12) advances `payments.state` but deliberately not
 * `bookings.state`; webhooks are unreachable in a local demo, so the
 * confirmation page — which the traveller always lands on after confirm —
 * calls this instead, and the seed script uses the same path. Idempotent:
 * a booking already past QUOTED is returned unchanged.
 */
export async function syncAuthorization(
  bookingId: string,
): Promise<{ state: BookingState; livePaymentStatus: string | null }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw new Error(`Unknown booking ${bookingId}`);

  const payment = await flightPaymentFor(bookingId);
  const live = await getPayment(payment.hsPaymentId);

  // Keep the payment row truthful regardless of whether the booking
  // advances (same fields the webhook would set).
  if (live.status !== payment.state || (live.connector ?? null) !== payment.connector) {
    await db.update(payments)
      .set({ connector: live.connector, state: live.status, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
  }

  if (booking.state !== 'QUOTED' || live.status !== 'requires_capture') {
    return { state: booking.state, livePaymentStatus: live.status };
  }

  // D-007: the payment is authorized, so `connector` is now real — this is
  // exactly the post-authorization moment the capability check belongs to.
  // A flight stranded on an incapable connector throws here (the webhook
  // path additionally voids; this read path surfaces it loudly instead).
  assertCapableOrThrow(live.connector, 'flight');

  const state = nextState('QUOTED', 'AUTH_SUCCEEDED');
  await db.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, bookingId));
  await recordEvent(bookingId, 'payment.authorized', { connector: live.connector });

  // Task 18's fallback path (recorded in D-023): if webhook deliveries don't
  // carry payment_method_id, this live read is where it gets persisted so
  // off-session ancillary charges have a stored method to charge.
  if (live.payment_method_id && !booking.paymentMethodId) {
    await db.update(bookings)
      .set({ paymentMethodId: live.payment_method_id, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
  }

  return { state, livePaymentStatus: live.status };
}
