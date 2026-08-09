import { describe, it, expect } from 'vitest';
import { newId, toHsPaymentId } from '../../lib/ids';

describe('ids', () => {
  it('generates 26-character ULIDs', () => {
    expect(newId()).toHaveLength(26);
  });

  it('derives a payment id of exactly 30 characters, every time', () => {
    for (let i = 0; i < 1000; i++) {
      expect(toHsPaymentId(newId())).toHaveLength(30);
    }
  });

  it('rejects an id that would not produce exactly 30 characters', () => {
    expect(() => toHsPaymentId('too-short')).toThrow(/30/);
  });
});
