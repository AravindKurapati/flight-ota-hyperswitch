import { describe, it, expect, beforeEach } from 'vitest';
import { attemptIssuance, resetIssuanceCounters } from '../../lib/ticketing';

describe('simulated GDS', () => {
  // The flaky itinerary's retry state is stateful in memory, keyed per
  // (itinerary, booking) (see lib/ticketing.ts). Reset before every test so outcomes
  // never depend on execution order.
  beforeEach(() => {
    resetIssuanceCounters();
  });

  it('issues a ticket for a normal itinerary', async () => {
    const r = await attemptIssuance('itin_sfo_jfk', 'bk_normal');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ticketNumber).toMatch(/^\d{3}-\d{10}$/);
  });

  it('always fails terminally for the designated failure itinerary', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await attemptIssuance('itin_bos_sea', `bk_terminal_${i}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe('terminal');
    }
  });

  it('fails terminally for an unknown itinerary id, never fabricating a ticket', async () => {
    const r = await attemptIssuance('itin_does_not_exist', 'bk_unknown');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('terminal');
  });

  it('is deterministic: same itinerary, same booking, same starting state -> same outcome', async () => {
    resetIssuanceCounters();
    const a = await attemptIssuance('itin_ord_lax', 'bk_deterministic');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.kind).toBe('retryable');

    resetIssuanceCounters();
    const b = await attemptIssuance('itin_ord_lax', 'bk_deterministic');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.kind).toBe('retryable');
  });

  it('fails once retryably, then succeeds on the next attempt, for the flaky itinerary', async () => {
    const first = await attemptIssuance('itin_ord_lax', 'bk_retry');
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.kind).toBe('retryable');

    const second = await attemptIssuance('itin_ord_lax', 'bk_retry');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.ticketNumber).toMatch(/^\d{3}-\d{10}$/);
  });

  it('gives each booking its own retry narrative for the flaky itinerary', async () => {
    const a1 = await attemptIssuance('itin_ord_lax', 'bk_a');
    expect(a1.ok).toBe(false);
    if (!a1.ok) expect(a1.kind).toBe('retryable');

    // A different booking against the same itinerary starts its own narrative —
    // it does not inherit bk_a's attempt count.
    const b1 = await attemptIssuance('itin_ord_lax', 'bk_b');
    expect(b1.ok).toBe(false);
    if (!b1.ok) expect(b1.kind).toBe('retryable');
  });
});
