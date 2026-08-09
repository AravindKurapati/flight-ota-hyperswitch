import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, refunds } from '../../db';
import { refund as hsRefund } from '../hyperswitch';
import { withIdempotency } from '../idempotency';
import { newId } from '../ids';
import { nextState, type BookingState } from '../state-machine';
import { recordEvent } from '../events';
import { flightPaymentFor } from './shared';

/**
 * Flow F: partial or full refund of a captured flight payment.
 *
 * Idempotency is layered (D-021):
 *  - `withIdempotency`, keyed on the natural key `refund:{paymentId}:{reason}`,
 *    is the primary guard — the same mechanism Tasks 10 and 18 use, with its
 *    reviewed release-only-on-throw contract.
 *  - our own `refund_id` (a ULID we mint) rides along on the Hyperswitch call,
 *    giving their API the same supply-our-own-identifier protection
 *    `hs_payment_id` gives payment creation (D-010).
 *  - the `(payment_id, reason)` unique index (SCHEMA.md) remains as
 *    defense-in-depth and the queryable record of what was refunded.
 *
 * Known, recorded gap (D-021): if `hsRefund` throws *ambiguously* — the
 * refund may have been created before the response was lost — this fn lets
 * the throw propagate, the key releases, and a retry could double-refund. A
 * read-back would need `GET /refunds/{id}`, unverified this session; the fix
 * mirrors `createIntentOrReadBack` exactly once that endpoint is confirmed.
 */
export async function refundBooking(input: {
  bookingId: string;
  amountMinor: number;
  reason: string;
}): Promise<{ state: BookingState }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
  if (!booking) throw new Error(`Unknown booking ${input.bookingId}`);
  if (booking.state !== 'TICKETED' && booking.state !== 'PARTIALLY_REFUNDED') {
    throw new Error(`Cannot refund a booking in state ${booking.state}`);
  }

  const payment = await flightPaymentFor(input.bookingId);

  const existing = await db.select().from(refunds).where(eq(refunds.paymentId, payment.id));
  // Failed attempts stay on record for audit but no money moved — counting
  // them would block legitimate retries against the over-refund cap
  // (observed live, V-005: Authorize.net refuses credits on unsettled
  // captures with error 54, returned as HTTP 200 + status 'failed').
  const alreadyRefunded = existing
    .filter((r) => r.state !== 'failed' && r.state !== 'failure')
    .reduce((sum, r) => sum + r.amountMinor, 0);
  if (alreadyRefunded + input.amountMinor > payment.amountMinor) {
    throw new Error(
      `Refund exceeds captured amount: ${alreadyRefunded} + ${input.amountMinor} > ${payment.amountMinor}`,
    );
  }

  const key = `refund:${payment.id}:${input.reason}`;

  const { result } = await withIdempotency(
    key,
    '/api/bookings/refund',
    { bookingId: input.bookingId, amountMinor: input.amountMinor, reason: input.reason },
    async () => {
      const refundId = newId();

      const hsResult = await hsRefund({
        hsPaymentId: payment.hsPaymentId,
        amountMinor: input.amountMinor,
        reason: input.reason,
        refundId,
      });

      // Persist the attempt whatever its status — the row is the audit
      // record. On a retry after a FAILED attempt under the same reason, the
      // (payment_id, reason) unique index would reject a second insert, so
      // the failed row is superseded in place instead.
      await db.insert(refunds).values({
        id: refundId, paymentId: payment.id, hsRefundId: hsResult.refund_id,
        amountMinor: input.amountMinor, reason: input.reason, state: hsResult.status,
      }).onConflictDoUpdate({
        target: [refunds.paymentId, refunds.reason],
        set: {
          hsRefundId: hsResult.refund_id, amountMinor: input.amountMinor,
          state: hsResult.status, updatedAt: new Date(),
        },
      });

      // Hyperswitch reports a connector refusal as HTTP 200 with
      // status 'failed' — acceptance of the request is not success of the
      // refund. No money moved, so the booking must not move either; the
      // throw releases the idempotency key so the caller can retry once the
      // underlying cause (e.g. an unsettled capture) clears.
      if (hsResult.status === 'failed' || hsResult.status === 'failure') {
        await recordEvent(input.bookingId, 'refund.failed', {
          amount: input.amountMinor, reason: input.reason, refundId,
          ...(hsResult.error_message ? { errorMessage: hsResult.error_message } : {}),
        });
        throw new Error(
          `Refund failed at the connector${hsResult.error_message ? `: ${hsResult.error_message}` : ''}`,
        );
      }

      const total = alreadyRefunded + input.amountMinor;
      const state = nextState(
        booking.state,
        total >= payment.amountMinor ? 'REFUNDED_FULL' : 'REFUNDED_PARTIAL',
      );
      await db.update(bookings).set({ state, updatedAt: new Date() }).where(eq(bookings.id, input.bookingId));
      await recordEvent(input.bookingId, 'refund.created', { amount: input.amountMinor, reason: input.reason });

      return { state };
    },
  );

  return result;
}
