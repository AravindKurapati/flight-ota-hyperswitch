// Unit test for app/api/bookings/route.ts. No database needed — lib/bookings
// is mocked so this exercises only the route's own job: parse, delegate,
// map errors to status codes. In particular it proves correction 3 from the
// task-10 brief: the route maps typed idempotency error classes with
// `instanceof`, never by matching on `error.message` text.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../../lib/bookings', () => ({
  createBooking: vi.fn(),
}));

import { POST } from '../../app/api/bookings/route';
import { createBooking } from '../../lib/bookings';
import {
  IdempotencyFingerprintMismatchError,
  IdempotencyInFlightError,
  IdempotencyClaimExhaustedError,
} from '../../lib/idempotency';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/bookings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const validPayload = {
  itineraryId: 'itin_sfo_jfk',
  passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }],
  idempotencyKey: 'idem_route_test_key',
};

describe('POST /api/bookings', () => {
  beforeEach(() => {
    vi.mocked(createBooking).mockReset();
  });

  it('returns 400 with flattened zod errors for a missing itineraryId', async () => {
    const res = await POST(request({ ...validPayload, itineraryId: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('rejects zero passengers with 400 (edge case)', async () => {
    const res = await POST(request({ ...validPayload, passengers: [] }));
    expect(res.status).toBe(400);
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('rejects a too-short idempotency key with 400', async () => {
    const res = await POST(request({ ...validPayload, idempotencyKey: 'short' }));
    expect(res.status).toBe(400);
    expect(createBooking).not.toHaveBeenCalled();
  });

  it('returns 200 with the booking result on success', async () => {
    vi.mocked(createBooking).mockResolvedValue({
      bookingId: 'bk_1',
      clientSecret: 'cs_1',
      publishableKey: 'pk_snd_x',
    });
    const res = await POST(request(validPayload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ bookingId: 'bk_1', clientSecret: 'cs_1', publishableKey: 'pk_snd_x' });
  });

  it('maps IdempotencyFingerprintMismatchError to 422 (correction 3)', async () => {
    vi.mocked(createBooking).mockRejectedValue(new IdempotencyFingerprintMismatchError('k'));
    const res = await POST(request(validPayload));
    expect(res.status).toBe(422);
  });

  it('maps IdempotencyInFlightError to 409 (correction 3)', async () => {
    vi.mocked(createBooking).mockRejectedValue(new IdempotencyInFlightError('k'));
    const res = await POST(request(validPayload));
    expect(res.status).toBe(409);
  });

  it('maps IdempotencyClaimExhaustedError to 409 (correction 3)', async () => {
    vi.mocked(createBooking).mockRejectedValue(new IdempotencyClaimExhaustedError('k', 5));
    const res = await POST(request(validPayload));
    expect(res.status).toBe(409);
  });

  it('maps an unrecognized error to 500', async () => {
    vi.mocked(createBooking).mockRejectedValue(new Error('boom'));
    const res = await POST(request(validPayload));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('boom');
  });

  it('does not match on error message text (correction 3): a plain Error whose message says "already in flight" still maps to 500, not 409', async () => {
    vi.mocked(createBooking).mockRejectedValue(
      new Error('this message happens to say already in flight but is not the typed error'),
    );
    const res = await POST(request(validPayload));
    expect(res.status).toBe(500);
  });
});
