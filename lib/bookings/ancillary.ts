import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../db';
import { chargeOffSession, getPayment } from '../hyperswitch';
import { withIdempotency } from '../idempotency';
import { newId, toHsPaymentId } from '../ids';
import { recordEvent } from '../events';

/**
 * Mirrors `createIntentOrReadBack` (lib/bookings/create.ts, task-10
 * correction 1): if `chargeOffSession` throws, the payment may have actually
 * gone through at Hyperswitch before the response was lost. Read it back by
 * the id we control before deciding the charge genuinely failed. Per
 * withIdempotency's contract, a throw from this function releases the
 * idempotency key — so a throw here must mean the charge is confirmed NOT
 * to have happened, not merely that our HTTP call failed.
 */
async function chargeOrReadBack(
  hsPaymentId: string,
  input: Parameters<typeof chargeOffSession>[0],
) {
  try {
    return await chargeOffSession(input);
  } catch (err) {
    const readBack = await getPayment(hsPaymentId).catch(() => undefined);
    if (readBack) return readBack;
    throw err;
  }
}

/**
 * Flow H: a merchant-initiated, off-session charge against the payment
 * method the traveller consented to store at checkout
 * (`setup_future_usage: off_session`, Task 10) — extra bags, seat
 * selection, a change fee. The traveller is not present; consent lives in
 * the stored payment method's existence.
 */
export async function chargeAncillary(input: {
  bookingId: string;
  description: string;
  amountMinor: number;
  idempotencyKey: string;
}): Promise<{ status: string }> {
  const { result } = await withIdempotency(
    input.idempotencyKey,
    '/api/bookings/ancillary',
    { bookingId: input.bookingId, amountMinor: input.amountMinor, description: input.description },
    async () => {
      const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
      if (!booking) throw new Error(`Unknown booking ${input.bookingId}`);
      if (booking.state !== 'TICKETED') {
        throw new Error(`Cannot charge an ancillary on a booking in state ${booking.state}`);
      }
      if (!booking.paymentMethodId) {
        throw new Error(
          'No stored payment method for this booking; the traveller did not consent to save their card at checkout',
        );
      }

      const paymentId = newId();
      const hsPaymentId = toHsPaymentId(paymentId);

      await db.insert(payments).values({
        id: paymentId, bookingId: input.bookingId, kind: 'ancillary', hsPaymentId,
        amountMinor: input.amountMinor, captureMethod: 'automatic', state: 'pending',
      });

      const charged = await chargeOrReadBack(hsPaymentId, {
        hsPaymentId,
        amountMinor: input.amountMinor,
        customerId: booking.customerId!,
        paymentMethodId: booking.paymentMethodId,
        description: input.description,
      });

      await db.update(payments)
        .set({ connector: charged.connector, state: charged.status, updatedAt: new Date() })
        .where(eq(payments.id, paymentId));
      await recordEvent(input.bookingId, 'ancillary.charged', {
        description: input.description, amount: input.amountMinor,
      });

      return { status: charged.status };
    },
  );
  return result;
}
