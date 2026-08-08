// Unit-level tests for the webhook handler: the pure signature-verification
// function, plus the parts of the route that can be exercised WITHOUT a real
// database (rejection happens before any db query is ever made). The
// happy-path state-update assertions (which need a real `payments` row) live
// in tests/integration/webhooks.test.ts instead, gated the same way every
// other integration test in this repo is (tests/integration/schema.test.ts).
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { verifySignature } from '../../lib/webhooks';

describe('webhook signature', () => {
  const secret = process.env.HYPERSWITCH_WEBHOOK_SECRET!;

  it('accepts a correctly signed payload', () => {
    const body = JSON.stringify({ event_type: 'payment_succeeded' });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(verifySignature(body, sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const body = JSON.stringify({ event_type: 'payment_succeeded' });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(verifySignature(JSON.stringify({ event_type: 'evil' }), sig)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifySignature('{}', 'abc')).toBe(false);
  });

  // Correction 2: whether Hyperswitch sends x-webhook-signature-512 in
  // lowercase, uppercase, or mixed case is unverified this session. A
  // correctly-computed signature must still be accepted regardless of the
  // case it arrives in, since hex case carries no entropy.
  it('accepts a correct signature sent in uppercase', () => {
    const body = JSON.stringify({ event_type: 'payment_succeeded' });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    expect(verifySignature(body, sig.toUpperCase())).toBe(true);
  });

  it('accepts a correct signature sent in mixed case', () => {
    const body = JSON.stringify({ event_type: 'payment_succeeded' });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    const mixed = sig
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join('');
    expect(verifySignature(body, mixed)).toBe(true);
  });
});

// Route-level tests (Correction 3) that do not require a real DATABASE_URL:
// both cases return before the route ever issues a db query, so they run
// hermetically in every environment, unlike tests/integration/webhooks.test.ts.
describe('POST /api/webhooks/hyperswitch (no database required)', () => {
  const secret = process.env.HYPERSWITCH_WEBHOOK_SECRET!;

  function signedRequest(rawBody: string, signature: string): NextRequest {
    return new NextRequest('http://localhost/api/webhooks/hyperswitch', {
      method: 'POST',
      body: rawBody,
      headers: signature ? { 'x-webhook-signature-512': signature } : {},
    });
  }

  it('rejects a tampered signature with 401', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const body = JSON.stringify({
      content: { object: { payment_id: 'pay_does_not_matter_here_00', status: 'succeeded' } },
    });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    const tamperedBody = JSON.stringify({
      content: { object: { payment_id: 'pay_does_not_matter_here_00', status: 'cancelled' } },
    });

    const res = await POST(signedRequest(tamperedBody, sig));
    expect(res.status).toBe(401);
  });

  it('rejects a request with no signature header at all, with 401, without throwing', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const body = JSON.stringify({ content: { object: { payment_id: 'x', status: 'succeeded' } } });

    const res = await POST(signedRequest(body, ''));
    expect(res.status).toBe(401);
  });

  it('does not crash on a correctly-signed but malformed (non-JSON) body', async () => {
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const rawBody = 'this is not json{{{';
    const sig = createHmac('sha512', secret).update(rawBody).digest('hex');

    const res = await POST(signedRequest(rawBody, sig));
    // Must not throw (a thrown error inside the route would reject this
    // promise and fail the test); it should also not trigger a 24h retry
    // storm from Hyperswitch, so it comes back 200 rather than 4xx/5xx.
    expect(res.status).toBe(200);
    const bodyJson = await res.json();
    expect(bodyJson).toEqual({ ok: true });
  });

  it('req.text() on the route sees the exact raw bytes the signature was computed over', async () => {
    // Proves the App Router Route Handler's req.text() round-trips the raw
    // body byte-for-byte -- if it normalized whitespace or re-serialized
    // JSON in any way, this signature (computed over the exact string below,
    // with irregular spacing) would fail to verify and the route would 401
    // instead of falling through to the "unknown payment shape" 200 path.
    const { POST } = await import('../../app/api/webhooks/hyperswitch/route');
    const rawBody = '{ "content" :  { "object": {} } }';
    const sig = createHmac('sha512', secret).update(rawBody).digest('hex');

    const res = await POST(signedRequest(rawBody, sig));
    expect(res.status).toBe(200);
  });
});
