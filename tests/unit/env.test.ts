import { describe, it, expect, vi } from 'vitest';

describe('env', () => {
  it('throws when a required variable is missing', async () => {
    const original = process.env.HYPERSWITCH_API_KEY;
    delete process.env.HYPERSWITCH_API_KEY;
    vi.resetModules();
    await expect(import('../../lib/env')).rejects.toThrow(/HYPERSWITCH_API_KEY/);
    process.env.HYPERSWITCH_API_KEY = original;
  });
});
