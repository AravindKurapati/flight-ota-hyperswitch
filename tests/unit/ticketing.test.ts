import { describe, it, expect, beforeEach } from 'vitest';
import { attemptIssuance, resetIssuanceCounters } from '../../lib/ticketing';

describe('simulated GDS', () => {
  // The flaky itinerary is stateful in memory (see lib/ticketing.ts). Reset before
  // every test so outcomes never depend on execution order.
  beforeEach(() => {
    resetIssuanceCounters();
  });

  it('issues a ticket for a normal itinerary', async () => {
    const r = await attemptIssuance('itin_sfo_jfk');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ticketNumber).toMatch(/^\d{3}-\d{10}$/);
  });

  it('always fails terminally for the designated failure itinerary', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await attemptIssuance('itin_bos_sea');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('terminal');
    }
  });

  it('is deterministic for a fixed-outcome itinerary, so the demo is reproducible', async () => {
    const a = await attemptIssuance('itin_sfo_jfk');
    const b = await attemptIssuance('itin_sfo_jfk');
    expect(a.ok).toBe(b.ok);

    const c = await attemptIssuance('itin_bos_sea');
    const d = await attemptIssuance('itin_bos_sea');
    expect(c.ok).toBe(d.ok);
  });

  it('fails once retryably, then succeeds on the next attempt, for the flaky itinerary', async () => {
    const first = await attemptIssuance('itin_ord_lax');
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.kind).toBe('retryable');

    const second = await attemptIssuance('itin_ord_lax');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.ticketNumber).toMatch(/^\d{3}-\d{10}$/);
  });
});
