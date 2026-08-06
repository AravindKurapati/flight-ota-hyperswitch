import { describe, it, expect } from 'vitest';
import { usd, formatUsd, fareBreakdown } from '../../lib/money';

describe('money', () => {
  it('converts dollars to minor units as integers', () => {
    expect(usd(654)).toBe(65400);
    expect(usd(654.4)).toBe(65440);
  });

  it('never produces a fractional minor unit', () => {
    expect(Number.isInteger(usd(19.99))).toBe(true);
    expect(usd(19.99)).toBe(1999);
  });

  it('formats minor units for display', () => {
    expect(formatUsd(65400)).toBe('$654.00');
  });

  it('produces a breakdown whose parts sum exactly to the total', () => {
    const b = fareBreakdown(50000);
    expect(b.base + b.excise + b.segment + b.september11).toBe(b.total);
  });
});
