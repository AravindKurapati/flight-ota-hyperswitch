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
//
// Visual layer: Hallmark Split Studio / Almanac (see app/globals.css). The
// left pane states the payment invariant the prototype exists to prove; the
// right pane is the booking form styled as a timetable. Logic is unchanged
// from the pre-redesign page.
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

  function departureLabel(departsAt: string): string {
    return new Date(departsAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  return (
    <>
      <header className="nav-edge">
        <a className="wordmark" href="/">
          Flight OTA<small>sandbox</small>
        </a>
        <a className="nav-edge__link" href="/ops">
          Ops console →
        </a>
      </header>

      <main className="studio">
        <section className="promise" aria-label="How payment works">
          <h1>
            Pay when the <span className="rule-word">ticket exists</span>.
          </h1>
          <p>
            Your card is authorized at booking and captured only after the airline
            issues your ticket. If issuance fails, the hold is released — not refunded,
            released.
          </p>
          <p className="fine">
            Free cancellation within 24 hours. Runs on the Hyperswitch sandbox:
            no real charges, test cards only.
          </p>
        </section>

        <form className="booking" onSubmit={handleSubmit}>
          <fieldset>
            <legend>Itinerary</legend>
            <div className="timetable">
              {ITINERARIES.map((itin) => {
                const fare = fareBreakdown(itin.baseFareMinor);
                return (
                  <label key={itin.id} className="route">
                    <input
                      type="radio"
                      name="itinerary"
                      value={itin.id}
                      checked={itineraryId === itin.id}
                      onChange={() => setItineraryId(itin.id)}
                    />
                    <span className="route__body">
                      <span className="route__carrier">
                        {itin.carrier} · {itin.origin} → {itin.destination}
                      </span>
                      <span className="route__meta">
                        {itin.flightNumber} · departs {departureLabel(itin.departsAt)}
                      </span>
                    </span>
                    <span className="route__fare">{formatUsd(fare.total)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend>Traveller</legend>
            <div className="traveller">
              <div className="field">
                <label htmlFor="first-name">First name</label>
                <input
                  id="first-name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="last-name">Last name</label>
                <input
                  id="last-name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                  required
                />
              </div>
            </div>
          </fieldset>

          <div className="booking__foot">
            <button className="btn" type="submit" disabled={submitting} aria-busy={submitting}>
              {submitting ? 'Booking…' : 'Continue to payment'}
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </main>

      <footer className="foot-line">
        <p>Hyperswitch hosted sandbox · auth-then-capture · one traveller per booking</p>
      </footer>
    </>
  );
}
