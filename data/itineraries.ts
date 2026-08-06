import { usd } from '../lib/money';

export type Itinerary = {
  id: string;
  origin: string;
  destination: string;
  carrier: string;
  flightNumber: string;
  departsAt: string;
  baseFareMinor: number;
};

export const ITINERARIES: Itinerary[] = [
  {
    id: 'itin_sfo_jfk',
    origin: 'SFO', destination: 'JFK',
    carrier: 'Meridian Air', flightNumber: 'MR 412',
    departsAt: '2026-09-14T07:20:00-07:00',
    baseFareMinor: usd(318),
  },
  {
    // Fails issuance once with a retryable GDS timeout, then succeeds. Drives the
    // "held in TICKETING, retry succeeds" narrative on demand.
    id: 'itin_ord_lax',
    origin: 'ORD', destination: 'LAX',
    carrier: 'Northstar', flightNumber: 'NS 88',
    departsAt: '2026-09-21T16:05:00-05:00',
    baseFareMinor: usd(214),
  },
  {
    // Designated always-fails-issuance itinerary. Drives flow D on demand.
    id: 'itin_bos_sea',
    origin: 'BOS', destination: 'SEA',
    carrier: 'Cascade Airways', flightNumber: 'CW 1190',
    departsAt: '2026-10-02T09:45:00-04:00',
    baseFareMinor: usd(487),
  },
];

export function findItinerary(id: string): Itinerary | undefined {
  return ITINERARIES.find((i) => i.id === id);
}
