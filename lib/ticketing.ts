/**
 * Simulated GDS. In production this is where the OTA calls the airline to issue a
 * ticket. Here it is a deterministic simulation keyed off itinerary id (and, for the
 * stateful case, booking id), so the demo is reproducible: replaying the same booking
 * against the same itinerary always drives the same narrative.
 *
 * The retryable/terminal split is not cosmetic — lib/bookings issueTicket branches on
 * it: retryable leaves the booking in TICKETING and holds the authorization for
 * another issuance attempt; terminal voids the authorization immediately and the
 * traveller is never charged. Retryable models a transient GDS-side failure (a
 * timeout) that a second attempt can plausibly clear. Terminal models a failure no
 * retry can fix (the fare was withdrawn, or the itinerary id doesn't exist) — holding
 * funds against either would be wrong.
 */

import { findItinerary } from '../data/itineraries';

export type IssuanceResult =
  | { ok: true; ticketNumber: string }
  | { ok: false; kind: 'retryable' | 'terminal'; reason: string };

/** Itineraries that never issue. Drives flow D reproducibly. */
const ALWAYS_FAILS_TERMINAL = new Set(['itin_bos_sea']);

/** Itineraries that fail once with a transient error before succeeding. */
const FAILS_ONCE_RETRYABLE = new Set(['itin_ord_lax']);

// Known simplification: retry state lives in this module-level Map, so it is scoped
// to a single process. That's fine for a prototype demo but would not survive a
// serverless cold start: a retry that lands on a fresh instance has no memory of the
// first attempt, so it re-runs the "first attempt" branch and fails retryably again
// instead of advancing to success. A demoer clicking retry against a cold instance
// would see it appear stuck rather than progress. Keying by (itineraryId, bookingId)
// makes each booking's narrative independent, but does not fix this — the map is
// still per-process either way. A production version would key retry state off the
// booking row instead of module memory.
const attemptCounts = new Map<string, number>();

function ticketNumber(): string {
  const airline = '016';
  const serial = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return `${airline}-${serial}`;
}

export async function attemptIssuance(
  itineraryId: string,
  bookingId: string,
): Promise<IssuanceResult> {
  if (!findItinerary(itineraryId)) {
    return { ok: false, kind: 'terminal', reason: `Unknown itinerary ${itineraryId}` };
  }

  if (ALWAYS_FAILS_TERMINAL.has(itineraryId)) {
    return { ok: false, kind: 'terminal', reason: 'Fare no longer available at the carrier' };
  }

  if (FAILS_ONCE_RETRYABLE.has(itineraryId)) {
    const key = `${itineraryId}:${bookingId}`;
    const n = (attemptCounts.get(key) ?? 0) + 1;
    attemptCounts.set(key, n);
    if (n === 1) {
      return { ok: false, kind: 'retryable', reason: 'GDS timeout' };
    }
  }

  return { ok: true, ticketNumber: ticketNumber() };
}

/** Test and demo helper — resets the retryable counter. */
export function resetIssuanceCounters(): void {
  attemptCounts.clear();
}
