import { describe, it, expect } from 'vitest';
import { nextState, canTransition, TERMINAL_STATES } from '../../lib/state-machine';

describe('booking state machine', () => {
  it('authorizes from quoted', () => {
    expect(nextState('QUOTED', 'AUTH_SUCCEEDED')).toBe('AUTHORIZED');
  });

  it('returns to quoted on retry after a decline, so the intent is reused', () => {
    expect(nextState('QUOTED', 'AUTH_DECLINED')).toBe('PAYMENT_FAILED');
    expect(nextState('PAYMENT_FAILED', 'RETRY')).toBe('QUOTED');
  });

  it('holds in TICKETING on a retryable issuance failure', () => {
    expect(nextState('TICKETING', 'ISSUANCE_FAILED_RETRYABLE')).toBe('TICKETING');
  });

  it('voids on a terminal issuance failure', () => {
    expect(nextState('TICKETING', 'ISSUANCE_FAILED_TERMINAL')).toBe('VOIDED');
  });

  it('allows a DOT cancellation only while authorized', () => {
    expect(nextState('AUTHORIZED', 'CANCELLED_IN_WINDOW')).toBe('VOIDED');
    expect(canTransition('TICKETED', 'CANCELLED_IN_WINDOW')).toBe(false);
  });

  it('never reaches TICKETED without passing through TICKETING', () => {
    expect(canTransition('AUTHORIZED', 'ISSUANCE_SUCCEEDED')).toBe(false);
    expect(nextState('AUTHORIZED', 'ISSUANCE_STARTED')).toBe('TICKETING');
    expect(nextState('TICKETING', 'ISSUANCE_SUCCEEDED')).toBe('TICKETED');
  });

  it('allows a partial refund to become full', () => {
    expect(nextState('PARTIALLY_REFUNDED', 'REFUNDED_FULL')).toBe('REFUNDED');
  });

  it('treats VOIDED and REFUNDED as terminal', () => {
    expect(TERMINAL_STATES.has('VOIDED')).toBe(true);
    expect(TERMINAL_STATES.has('REFUNDED')).toBe(true);
    expect(TERMINAL_STATES.has('PARTIALLY_REFUNDED')).toBe(false);
  });

  it('throws on an illegal transition rather than silently ignoring it', () => {
    expect(() => nextState('VOIDED', 'AUTH_SUCCEEDED')).toThrow(/VOIDED/);
  });
});
