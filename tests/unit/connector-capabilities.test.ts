import { describe, it, expect } from 'vitest';
import { assertCapableOrThrow, capabilitiesFor } from '../../lib/connector-capabilities';

describe('connector capabilities', () => {
  it('knows fauxpay cannot capture, void, or run MIT', () => {
    const c = capabilitiesFor('fauxpay');
    expect(c.capture).toBe(false);
    expect(c.void).toBe(false);
    expect(c.mit).toBe(false);
    expect(c.webhooks).toBe(false);
  });

  it('rejects a flight payment on a connector that cannot capture', () => {
    expect(() => assertCapableOrThrow('fauxpay', 'flight')).toThrow(/capture/);
  });

  it('names the connector, the payment kind, and the missing capability in the error', () => {
    try {
      assertCapableOrThrow('fauxpay', 'flight');
      throw new Error('expected assertCapableOrThrow to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('fauxpay');
      expect(message).toContain('flight');
      expect(message).toContain('capture');
      expect(message).toContain('void');
    }
  });

  it('accepts a flight payment on authorizedotnet, the capture-capable connector (D-012)', () => {
    expect(() => assertCapableOrThrow('authorizedotnet', 'flight')).not.toThrow();
  });

  it('accepts a protection payment on fauxpay, which needs nothing beyond authorize', () => {
    expect(() => assertCapableOrThrow('fauxpay', 'protection')).not.toThrow();
  });

  it('rejects an ancillary (off-session MIT) charge on fauxpay', () => {
    expect(() => assertCapableOrThrow('fauxpay', 'ancillary')).toThrow(/mit/);
  });

  it('accepts an ancillary charge on authorizedotnet', () => {
    expect(() => assertCapableOrThrow('authorizedotnet', 'ancillary')).not.toThrow();
  });

  it('treats an unknown connector as incapable rather than assuming the best', () => {
    expect(() => assertCapableOrThrow('some_new_psp', 'flight')).toThrow();
    expect(capabilitiesFor('some_new_psp')).toEqual({
      capture: false,
      void: false,
      mit: false,
      webhooks: false,
    });
  });

  it('treats a null connector as incapable, not as a free pass', () => {
    // Hyperswitch returns `connector: string | null` on a payment response — null is
    // reachable (e.g. before routing has resolved one), so it must fail closed too.
    expect(capabilitiesFor(null)).toEqual({
      capture: false,
      void: false,
      mit: false,
      webhooks: false,
    });
    expect(() => assertCapableOrThrow(null, 'flight')).toThrow();
    expect(() => assertCapableOrThrow(null, 'protection')).not.toThrow();
  });
});
