import 'server-only';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, idempotencyRecords } from '../db';

// Bounds the "row vanished between our insert-conflict and our follow-up
// select" retry loop below (see the `!existing` branch). That race is real
// but narrow, and never has a reason to fire more than once or twice in
// practice; the bound exists only to turn a pathological, repeated race into
// a loud error instead of a silent infinite loop.
const MAX_CLAIM_ATTEMPTS = 5;

/**
 * The same idempotency key was reused with a request body that hashes
 * differently from the one stored for it. This is a client bug (or an
 * attempted replay with a mutated payload), not a server or concurrency
 * condition — the caller should treat it as 409/422, never retry as-is.
 */
export class IdempotencyFingerprintMismatchError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was reused with a different request body`);
    this.name = 'IdempotencyFingerprintMismatchError';
  }
}

/**
 * A concurrent request already holds this key and has not finished. This is
 * retryable — the caller (or its client) can poll or re-request shortly —
 * but it must NOT be treated as "safe to run fn() again": per D-011, the
 * correct response to ambiguity is to read state back, never to re-run the
 * mutation.
 */
export class IdempotencyInFlightError extends Error {
  constructor(readonly key: string) {
    super(`Request for idempotency key "${key}" is already in flight`);
    this.name = 'IdempotencyInFlightError';
  }
}

function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

/**
 * Runs `fn()` at most once per (key, body) pair and replays the stored
 * result on a repeat call with the same key and body.
 *
 * Guards the four mutation points named in D-009 (create-intent, confirm,
 * capture, refund) against double-clicks and duplicate retries. See D-010 and
 * D-011 in DECISIONS.md for the identity and ambiguity-resolution reasoning
 * this builds on.
 *
 * Throws {@link IdempotencyFingerprintMismatchError} if `key` is reused with a
 * different `body`, and {@link IdempotencyInFlightError} if a concurrent call
 * currently holds `key`. Any error `fn()` itself throws propagates unchanged.
 */
export async function withIdempotency<T>(
  key: string,
  endpoint: string,
  body: unknown,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const fp = fingerprint(body);

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const inserted = await db
      .insert(idempotencyRecords)
      .values({ key, endpoint, requestFingerprint: fp, status: 'in_flight' })
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) {
      return runAndFinalize(key, fn);
    }

    const [existing] = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.key, key));

    if (!existing) {
      // The row that caused our insert to conflict is gone by the time we
      // read it back: a concurrent attempt's fn() failed and its own
      // cleanup (see runAndFinalize) deleted the row between our conflict
      // and this select. The key is free again — loop back and claim it
      // ourselves rather than dereferencing a row that no longer exists
      // (task-8 correction 2).
      continue;
    }

    if (existing.requestFingerprint !== fp) {
      throw new IdempotencyFingerprintMismatchError(key);
    }
    if (existing.status === 'complete') {
      return { result: existing.response as T, replayed: true };
    }
    // in_flight: a concurrent request holds it, or a previous attempt died
    // mid-flight. Per D-011 the caller resolves ambiguity by reading state
    // back, never by re-running the mutation — so this is an error, not a
    // silent retry of fn().
    throw new IdempotencyInFlightError(key);
  }

  throw new Error(
    `Idempotency key "${key}" could not be claimed after ${MAX_CLAIM_ATTEMPTS} attempts due to repeated concurrent contention`,
  );
}

// Runs fn() and reconciles the idempotency record with its outcome. Split
// out from withIdempotency's claim loop so the one distinction that matters
// most (task-8 correction 1) reads as a single, obvious boundary:
//
//   - fn() throws            -> no side effect is known to have happened.
//                                Release the key so a retry can attempt
//                                fn() again.
//   - fn() succeeds           -> a real side effect (e.g. a Hyperswitch
//                                payment) has happened. From this point the
//                                key must NEVER be released, even if the
//                                bookkeeping update below fails. Releasing
//                                it would let a retry call fn() again and
//                                cause exactly the double charge this
//                                function exists to prevent. If the update
//                                fails, the record is deliberately left
//                                `in_flight`; the caller resolves that by
//                                reading state back (D-011), not by retrying.
async function runAndFinalize<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.key, key));
    throw e;
  }

  // idempotency_records has no updated_at trigger (unlike bookings, payments
  // and refunds — see drizzle/0001_updated_at_triggers.sql), so updatedAt is
  // set explicitly here rather than left to the database.
  await db
    .update(idempotencyRecords)
    .set({ response: result as Record<string, unknown>, status: 'complete', updatedAt: new Date() })
    .where(eq(idempotencyRecords.key, key));

  return { result, replayed: false };
}
