/**
 * Simulated GDS. In production this is where the OTA calls the airline to issue a
 * ticket. Here it is a deterministic simulation keyed off itinerary id, so the demo
 * is reproducible: the same itinerary always drives the same narrative.
 *
 * The retryable/terminal split is not cosmetic — lib/bookings issueTicket branches on
 * it: retryable leaves the booking in TICKETING and holds the authorization for
 * another issuance attempt; terminal voids the authorization immediately and the
 * traveller is never charged. Retryable models a transient GDS-side failure (a
 * timeout) that a second attempt can plausibly clear. Terminal models a failure no
 * retry can fix (the fare was withdrawn) — holding funds against it would be wrong.
 */

export type IssuanceResult =
  | { ok: true; ticketNumber: string }
  | { ok: false; kind: 'retryable' | 'terminal'; reason: string };

/** Itineraries that never issue. Drives flow D reproducibly. */
const ALWAYS_FAILS_TERMINAL = new Set(['itin_bos_sea']);

/** Itineraries that fail once with a transient error before succeeding. */
const FAILS_ONCE_RETRYABLE = new Set(['itin_ord_lax']);

// Known simplification: retry state lives in this module-level Map, so it is scoped
// to a single process. That's fine for a prototype demo but would not survive a
// serverless cold start — a fresh instance would forget it already failed once and
// the itinerary would issue on the first attempt again. A production version would
// key retry state off the booking row instead of the module.
const attemptCounts = new Map<string, number>();

function ticketNumber(): string {
  const airline = '016';
  const serial = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return `${airline}-${serial}`;
}

export async function attemptIssuance(itineraryId: string): Promise<IssuanceResult> {
  if (ALWAYS_FAILS_TERMINAL.has(itineraryId)) {
    return { ok: false, kind: 'terminal', reason: 'Fare no longer available at the carrier' };
  }

  if (FAILS_ONCE_RETRYABLE.has(itineraryId)) {
    const n = (attemptCounts.get(itineraryId) ?? 0) + 1;
    attemptCounts.set(itineraryId, n);
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
