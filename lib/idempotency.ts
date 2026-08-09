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

/**
 * The claim loop could not obtain the row for `key` after
 * {@link MAX_CLAIM_ATTEMPTS} attempts — the row kept vanishing out from under
 * a concurrent claimant faster than we could read it. Pathological and
 * extremely unlikely; a route handler should treat it the same way as
 * {@link IdempotencyInFlightError} (retryable, not a client error).
 */
export class IdempotencyClaimExhaustedError extends Error {
  constructor(readonly key: string, readonly attempts: number) {
    super(`Idempotency key "${key}" could not be claimed after ${attempts} attempts due to repeated concurrent contention`);
    this.name = 'IdempotencyClaimExhaustedError';
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
 * different `body`, {@link IdempotencyInFlightError} if a concurrent call
 * currently holds `key`, and {@link IdempotencyClaimExhaustedError} on
 * pathological repeated contention. Any error `fn()` itself throws propagates
 * unchanged.
 *
 * **Contract on `fn` — read this before passing a real Hyperswitch call in:**
 * this function releases the idempotency key if and only if `fn()` throws.
 * That is the *entire* guarantee; it is NOT the same as "a throw means
 * nothing happened", because that depends on what `fn` does, not on this
 * function. If `fn` performs a remote mutation whose outcome can be
 * ambiguous on failure — a timeout, an unparsable response, a dropped
 * connection after Hyperswitch has already created the payment — `fn` MUST
 * resolve that ambiguity itself before it throws: read the state back (D-011,
 * e.g. `GET /payments/{id}`) and either return the real result normally, or
 * throw only once it has confirmed nothing durable was created. A `fn` that
 * throws on ambiguous failure without doing this will cause exactly the
 * double charge this module exists to prevent — the key gets released, the
 * caller retries, and `fn` runs again against a payment that already exists.
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

  throw new IdempotencyClaimExhaustedError(key, MAX_CLAIM_ATTEMPTS);
}

// Runs fn() and reconciles the idempotency record with its outcome. Split
// out from withIdempotency's claim loop so the one distinction that matters
// most (task-8 correction 1) reads as a single, obvious boundary:
//
//   - fn() throws            -> the key is released so a retry can attempt
//                                fn() again. This is ONLY safe because of a
//                                contract this function places on its
//                                caller's fn (spelled out in withIdempotency's
//                                JSDoc): a throw must mean fn established
//                                that nothing durable was created. This
//                                function has no way to verify that itself —
//                                it is not a proven property of fn() throwing,
//                                it is what fn() is required to guarantee
//                                before it throws.
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
