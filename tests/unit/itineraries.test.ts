import { describe, it, expect } from 'vitest';
import { ITINERARIES, findItinerary } from '../../data/itineraries';

describe('itinerary fixtures', () => {
  it('finds every itinerary in the catalogue by id', () => {
    for (const itin of ITINERARIES) {
      expect(findItinerary(itin.id)).toEqual(itin);
    }
  });

  it('returns undefined for an id not in the catalogue', () => {
    expect(findItinerary('itin_does_not_exist')).toBeUndefined();
  });
});
