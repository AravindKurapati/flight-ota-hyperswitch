import { eq, and } from 'drizzle-orm';
import { db, bookings, payments } from '../../../db';
import { getPayment } from '../../../lib/hyperswitch';
import { syncAuthorization } from '../../../lib/bookings';
import { findItinerary } from '../../../data/itineraries';
import { formatUsd } from '../../../lib/money';

// Server Component (no 'use client'): this page only reads and renders, so
// it can be `async` directly and await `params` itself — unlike
// app/checkout/[bookingId]/page.tsx, which needs `use()` because it must
// stay a Client Component for its hooks (see the comment there).
export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { bookingId } = await params;

  // Task 19 / D-023: the traveller landing here is the one moment we know
  // checkout finished, and webhooks are unreachable in a local demo — so
  // this page is where QUOTED advances to AUTHORIZED (verified against a
  // live getPayment read inside syncAuthorization, not trusted state).
  // Best-effort: a transport failure here must not break the confirmation
  // page; the live read below still shows the true payment status.
  await syncAuthorization(bookingId).catch(() => undefined);

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) {
    return (
      <main style={{ maxWidth: 480, margin: '2rem auto', fontFamily: 'sans-serif' }}>
        <h1>Booking not found</h1>
      </main>
    );
  }

  const [paymentRow] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));

  // Read the live status straight from Hyperswitch rather than trusting
  // `payments.state` in our own DB: that column was only ever set once, at
  // create-intent time (lib/bookings/create.ts), before the traveller
  // confirmed anything. Webhook-driven updates to it land in a later task.
  // Reading live here is also what makes "requires_capture" visible on this
  // page as a substitute for a Control Center screenshot, per the task-11
  // hand-test.
  const intent = paymentRow ? await getPayment(paymentRow.hsPaymentId) : null;

  const itinerary = findItinerary(booking.itineraryId);

  return (
    <main style={{ maxWidth: 480, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h1>Booking confirmed</h1>
      <p>
        PNR: <strong>{booking.pnr}</strong>
      </p>
      {itinerary && (
        <p>
          {itinerary.carrier} {itinerary.flightNumber} · {itinerary.origin} →{' '}
          {itinerary.destination}
        </p>
      )}
      <p>Amount held: {formatUsd(booking.amountMinor)}</p>
      <p>
        Payment status: <strong>{intent?.status ?? 'unknown'}</strong>
      </p>
      <p>Your card is authorized, not charged. It will be captured once your ticket is issued.</p>
    </main>
  );
}
