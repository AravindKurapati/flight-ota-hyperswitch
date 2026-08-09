// Integration test against the real Neon sandbox database. Proves
// withIdempotency (D-009, D-010, D-011 in DECISIONS.md) actually prevents a
// double charge, including the failure-path defect described in task-8
// correction 1: a bookkeeping failure AFTER fn() has already succeeded must
// never release the key, because that would let a retry call fn() again.
//
// Skipped (visibly, not silently) when no real DATABASE_URL is configured —
// e.g. a clean clone with no .env — so `npm test` stays hermetic. Keys used
// here are fixed strings, not Date.now()-derived, so repeat runs actually
// exercise key reuse; every row this file creates is deleted in afterAll so
// a second run starts clean.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, idempotencyRecords } from '../../db';
import {
  withIdempotency,
  IdempotencyFingerprintMismatchError,
  IdempotencyInFlightError,
} from '../../lib/idempotency';
import { FALLBACK_DATABASE_URL } from '../setup-env';

const hasRealDatabase =
  !!process.env.DATABASE_URL && process.env.DATABASE_URL !== FALLBACK_DATABASE_URL;

const KEYS = {
  replay: 'idem_test_replay',
  mismatch: 'idem_test_mismatch',
  retryAfterFailure: 'idem_test_retry_after_failure',
  concurrent: 'idem_test_concurrent',
  bookkeepingFailure: 'idem_test_bookkeeping_failure',
  reuse: 'idem_test_reuse_after_cleanup',
};

async function deleteKey(key: string) {
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, key));
}

describe.skipIf(!hasRealDatabase)('withIdempotency (requires a real DATABASE_URL)', () => {
  afterAll(async () => {
    for (const key of Object.values(KEYS)) {
      await deleteKey(key);
    }
    // Close the pooled websocket connection so vitest can exit cleanly.
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it('runs the function once and replays the stored response on a repeat key+body', async () => {
    const key = KEYS.replay;
    await deleteKey(key);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { clientSecret: 'cs_abc' };
    };

    const first = await withIdempotency(key, '/api/bookings', { a: 1 }, fn);
    const second = await withIdempotency(key, '/api/bookings', { a: 1 }, fn);

    expect(calls).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ clientSecret: 'cs_abc' });
  });

  it('rejects the same key reused with a different body, as a typed fingerprint-mismatch error', async () => {
    const key = KEYS.mismatch;
    await deleteKey(key);
    const fn = async () => ({ ok: true });
    await withIdempotency(key, '/api/bookings', { a: 1 }, fn);

    const call = withIdempotency(key, '/api/bookings', { a: 2 }, fn);
    await expect(call).rejects.toBeInstanceOf(IdempotencyFingerprintMismatchError);
    try {
      await call;
      expect.unreachable('withIdempotency should have thrown');
    } catch (err) {
      expect((err as IdempotencyFingerprintMismatchError).key).toBe(key);
    }
  });

  it('does not cache a failure, so a retry with the same key can succeed', async () => {
    const key = KEYS.retryAfterFailure;
    await deleteKey(key);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return { ok: true };
    };

    await expect(withIdempotency(key, '/x', {}, fn)).rejects.toThrow('transient');
    const retry = await withIdempotency(key, '/x', {}, fn);
    expect(retry.result).toEqual({ ok: true });
    expect(retry.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('treats a concurrent call on the same in-flight key as IdempotencyInFlightError, never as a second execution', async () => {
    const key = KEYS.concurrent;
    await deleteKey(key);
    let calls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fn = async () => {
      calls += 1;
      await gate;
      return { ok: true };
    };

    const firstCall = withIdempotency(key, '/x', {}, fn);
    // Give the first call's INSERT time to land before the second call races it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondCall = withIdempotency(key, '/x', {}, async () => {
      calls += 1;
      return { ok: 'should not run' };
    });
    await expect(secondCall).rejects.toBeInstanceOf(IdempotencyInFlightError);

    releaseFirst();
    const first = await firstCall;
    expect(first.replayed).toBe(false);
    expect(calls).toBe(1); // only the first fn() ever ran
  });

  it('never releases the key when fn() succeeds but the bookkeeping update fails, so a retry does not re-run fn()', async () => {
    const key = KEYS.bookkeepingFailure;
    await deleteKey(key);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { ok: true };
    };

    const updateSpy = vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('simulated bookkeeping failure');
    });

    await expect(withIdempotency(key, '/x', {}, fn)).rejects.toThrow('simulated bookkeeping failure');
    updateSpy.mockRestore();

    expect(calls).toBe(1);
    const [row] = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, key));
    expect(row).toBeDefined();
    expect(row.status).toBe('in_flight'); // NOT deleted, NOT marked complete

    // A retry must not see the key as free (which would run fn() again and
    // double-charge) — it must observe "still in flight".
    const retry = withIdempotency(key, '/x', {}, fn);
    await expect(retry).rejects.toBeInstanceOf(IdempotencyInFlightError);
    expect(calls).toBe(1); // fn() was never called a second time
  });

  it('reuses a fixed key within the test after cleaning it, proving the guard does not depend on key uniqueness', async () => {
    const key = KEYS.reuse;
    await deleteKey(key);

    const first = await withIdempotency(key, '/x', { a: 1 }, async () => ({ round: 1 }));
    expect(first.replayed).toBe(false);

    // Clean the key up mid-test, exactly as afterAll will at the end of the run.
    await deleteKey(key);

    // Reusing the SAME fixed key again must behave as if it had never been
    // seen before — not throw a fingerprint mismatch, not replay round 1.
    const second = await withIdempotency(key, '/x', { a: 1 }, async () => ({ round: 2 }));
    expect(second.replayed).toBe(false);
    expect(second.result).toEqual({ round: 2 });
  });
});
