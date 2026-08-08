import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

/**
 * HMAC-SHA512 over the raw JSON body, keyed with the business profile's
 * `payment_response_hash_key` (delivered here as HYPERSWITCH_WEBHOOK_SECRET).
 * Verified against the live docs: header is `x-webhook-signature-512`.
 *
 * Correction 2: both sides are lowercased before comparison. Node's
 * `createHmac(...).digest('hex')` is always lowercase, but whether
 * Hyperswitch sends the header itself in lowercase, uppercase, or mixed case
 * is not verified this session. Lowercasing costs nothing -- hex case adds
 * no entropy to the signature -- and removes a plausible, unverified
 * correctness risk: a case mismatch here would silently 401 every genuine
 * webhook delivery.
 */
export function verifySignature(rawBody: string, signature: string): boolean {
  const expected = createHmac('sha512', env.HYPERSWITCH_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')
    .toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}
