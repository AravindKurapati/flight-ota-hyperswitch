'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ITINERARIES } from '../data/itineraries';
import { fareBreakdown, formatUsd } from '../lib/money';

// Home page: pick an itinerary, name the traveller, create a booking.
// Deliberately one passenger — multi-passenger fare math is already covered
// by Task 10's tests (lib/bookings/create.ts multiplies per-passenger total
// by passengers.length); this page exists to drive flows A/B end to end,
// not to re-exercise that.
export default function HomePage() {
  const router = useRouter();
  const [itineraryId, setItineraryId] = useState(ITINERARIES[0].id);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itineraryId,
          passengers: [{ firstName, lastName }],
          // crypto.randomUUID() is available in every browser this app
          // targets; the server's schema only requires length >= 8.
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        const message =
          typeof body.error === 'string' ? body.error : 'Could not create the booking.';
        setError(message);
        setSubmitting(false);
        return;
      }
      router.push(`/checkout/${body.bookingId}`);
    } catch {
      setError('Network error — please try again.');
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h1>Book a flight</h1>
      <form onSubmit={handleSubmit}>
        <fieldset>
          <legend>Itinerary</legend>
          {ITINERARIES.map((itin) => {
            const fare = fareBreakdown(itin.baseFareMinor);
            return (
              <label key={itin.id} style={{ display: 'block', margin: '0.5rem 0' }}>
                <input
                  type="radio"
                  name="itinerary"
                  value={itin.id}
                  checked={itineraryId === itin.id}
                  onChange={() => setItineraryId(itin.id)}
                />{' '}
                {itin.carrier} {itin.flightNumber} · {itin.origin} → {itin.destination} ·{' '}
                {formatUsd(fare.total)}
              </label>
            );
          })}
        </fieldset>

        <fieldset>
          <legend>Traveller</legend>
          <label>
            First name
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </label>
          <br />
          <label>
            Last name
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} required />
          </label>
        </fieldset>

        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? 'Booking…' : 'Continue to payment'}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </main>
  );
}
