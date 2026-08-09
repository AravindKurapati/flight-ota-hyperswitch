import 'server-only';
import { eq } from 'drizzle-orm';
import { db, bookings, payments, type PaymentKind } from '../../db';
import { newId, toHsPaymentId } from '../ids';
import { createAndConfirmDummyCharge } from '../hyperswitch';
import { assertCapableOrThrow } from '../connector-capabilities';
import { recordEvent } from '../events';

/**
 * Flow G: a $24.00 trip-protection add-on, auto-confirmed server-side
 * against the dummy connector (D-022). $24 is below the $50 routing
 * threshold (D-005), so this payment always lands on `fauxpay` — which is
 * the entire reason the fixed-test-card confirm in
 * `createAndConfirmDummyCharge` is acceptable here and nowhere else.
 */
const TRIP_PROTECTION_MINOR = 2400;

export async function addTripProtection(bookingId: string): Promise<{ connector: string | null }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) throw new Error(`Unknown booking ${bookingId}`);

  const paymentId = newId();
  const hsPaymentId = toHsPaymentId(paymentId);

  // The partial unique index on (booking_id, kind) — SCHEMA.md — rejects a
  // second protection payment for this booking. Insert first, same principle
  // as the refund guard: let the database reject a duplicate before any
  // money moves. An insert failure means the charge attempt never happens at
  // all, so there is no orphaned Hyperswitch charge to clean up.
  await db.insert(payments).values({
    id: paymentId, bookingId, kind: 'protection' satisfies PaymentKind, hsPaymentId,
    amountMinor: TRIP_PROTECTION_MINOR, captureMethod: 'automatic', state: 'pending',
  });

  const charged = await createAndConfirmDummyCharge({
    hsPaymentId,
    amountMinor: TRIP_PROTECTION_MINOR,
    customerId: booking.customerId!,
    description: 'Trip protection',
    orderDetails: [{ product_name: 'Trip protection', quantity: 1, amount: TRIP_PROTECTION_MINOR }],
  });

  // D-007: this is now a real, post-confirmation connector value — not the
  // premature null Task 10 correctly avoided asserting against at
  // create-intent time. `protection`'s current REQUIREMENTS
  // (lib/connector-capabilities.ts) list no required capabilities, so this
  // cannot throw today — it's here so a future kind or a changed
  // REQUIREMENTS table never needs this call site revisited to start
  // enforcing it.
  assertCapableOrThrow(charged.connector, 'protection');

  await db.update(payments)
    .set({ connector: charged.connector, state: charged.status, updatedAt: new Date() })
    .where(eq(payments.id, paymentId));
  await recordEvent(bookingId, 'protection.added', { connector: charged.connector });

  return { connector: charged.connector };
}
