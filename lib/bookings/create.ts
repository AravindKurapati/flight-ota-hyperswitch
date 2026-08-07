import 'server-only';
import { db, bookings, payments } from '../../db';
import { newId, toHsPaymentId } from '../ids';
import { fareBreakdown } from '../money';
import { findItinerary } from '../../data/itineraries';
import { createIntent, getPayment } from '../hyperswitch';
import type { CreateIntentInput, HsPayment } from '../hyperswitch.types';
import { withIdempotency } from '../idempotency';
import { recordEvent } from '../events';
import { env } from '../env';
import { type Passenger, DOT_VOID_WINDOW_MS, pnr } from './shared';

/**
 * Task-10 correction 1. `withIdempotency`'s `fn` contract (see its JSDoc in
 * lib/idempotency.ts, and D-013 in DECISIONS.md) is: the idempotency key is
 * released if and only if `fn()` throws, and a throw from `fn` MUST mean
 * nothing durable was created. `createIntent` can fail after Hyperswitch has
 * already created the payment — a timeout or an unparsable response can
 * arrive after the write already landed server-side (see the comments in
 * `call()`, lib/hyperswitch.ts). Letting that error propagate unresolved
 * would release the key, let the client retry, and create a *second*
 * Hyperswitch payment against the traveller's card — the exact double
 * charge this task exists to prevent.
 *
 * So: on failure, read the payment back by the `hs_payment_id` we ourselves
 * derived and control (D-010), per D-011 ("ambiguous outcomes resolve by
 * reading, never by retrying"):
 *   - the read-back finds the payment  -> creation actually succeeded;
 *     continue with it exactly as if `createIntent` had returned normally.
 *   - the read-back confirms no such payment exists -> nothing durable was
 *     created, and the original error is safe to rethrow.
 *   - the read-back itself fails (a second, independent transport failure)
 *     -> we cannot confirm either way. See DECISIONS.md D-014: this is
 *     treated the same as "does not exist" and the original error is
 *     rethrown rather than left unresolved, accepting the residual risk of
 *     a stray, uncaptured second authorization (never a double charge,
 *     because every flight authorization is `capture_method: manual` —
 *     D-002) rather than building a tri-state "don't release" signal into
 *     withIdempotency for this one call site.
 */
async function createIntentOrReadBack(input: CreateIntentInput): Promise<HsPayment> {
  try {
    return await createIntent(input);
  } catch (err) {
    const readBack = await getPayment(input.hsPaymentId).catch(() => undefined);
    if (readBack) return readBack;
    throw err;
  }
}

export async function createBooking(input: {
  itineraryId: string;
  passengers: Passenger[];
  idempotencyKey: string;
}): Promise<{ bookingId: string; clientSecret: string; publishableKey: string }> {
  const itinerary = findItinerary(input.itineraryId);
  if (!itinerary) throw new Error(`Unknown itinerary: ${input.itineraryId}`);

  const { result, replayed } = await withIdempotency(
    input.idempotencyKey,
    '/api/bookings',
    { itineraryId: input.itineraryId, passengers: input.passengers },
    async () => {
      const fare = fareBreakdown(itinerary.baseFareMinor);
      const perPassenger = fare.total;
      const total = perPassenger * input.passengers.length;

      const bookingId = newId();
      const paymentId = newId();
      const hsPaymentId = toHsPaymentId(paymentId);

      await db.insert(bookings).values({
        id: bookingId,
        pnr: pnr(),
        itineraryId: itinerary.id,
        passengers: input.passengers,
        amountMinor: total,
        state: 'QUOTED',
        customerId: `cus_${bookingId}`,
        voidDeadlineAt: new Date(Date.now() + DOT_VOID_WINDOW_MS),
      });

      await recordEvent(bookingId, 'booking.created', {
        itineraryId: itinerary.id,
        total,
      });

      const intent = await createIntentOrReadBack({
        hsPaymentId,
        amountMinor: total,
        captureMethod: 'manual',
        customerId: `cus_${bookingId}`,
        description: `${itinerary.carrier} ${itinerary.flightNumber} ${itinerary.origin}-${itinerary.destination}`,
        setupFutureUsage: 'off_session',
        returnUrl: `${env.APP_BASE_URL}/confirmation/${bookingId}`,
        orderDetails: [
          { product_name: 'Air fare', quantity: input.passengers.length, amount: fare.base },
          { product_name: 'US excise tax', quantity: input.passengers.length, amount: fare.excise },
          { product_name: 'Segment fee', quantity: input.passengers.length, amount: fare.segment },
          { product_name: 'September 11 security fee', quantity: input.passengers.length, amount: fare.september11 },
        ],
      });

      await db.insert(payments).values({
        id: paymentId,
        bookingId,
        kind: 'flight',
        hsPaymentId,
        amountMinor: total,
        captureMethod: 'manual',
        // Task-10 correction 5: capability (D-007, assertCapableOrThrow) is
        // deliberately NOT asserted here. At create-intent time the payment
        // has not been confirmed, so routing has not run and `connector` is
        // normally null. There is nothing to assert against yet — the
        // assertion belongs after authorization, in the confirm step
        // (Task 12), where `connector` is actually populated by Hyperswitch.
        connector: intent.connector,
        state: intent.status,
      });

      return {
        bookingId,
        clientSecret: intent.client_secret!,
        publishableKey: env.HYPERSWITCH_PUBLISHABLE_KEY,
      };
    },
  );

  if (replayed) {
    // Task-10 correction 6: SCHEMA.md:150-153 defines `idempotent.replay`
    // so a double-submit is observable in the booking's timeline rather
    // than silently swallowed. `result.bookingId` is available because a
    // replay always returns the original fn()'s stored response.
    await recordEvent(result.bookingId, 'idempotent.replay', {
      idempotencyKey: input.idempotencyKey,
    });
  }

  return result;
}
