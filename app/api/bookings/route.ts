import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createBooking } from '../../../lib/bookings';
import {
  IdempotencyFingerprintMismatchError,
  IdempotencyInFlightError,
  IdempotencyClaimExhaustedError,
} from '../../../lib/idempotency';

const schema = z.object({
  itineraryId: z.string().min(1),
  passengers: z.array(z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
  })).min(1),
  idempotencyKey: z.string().min(8),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return NextResponse.json(await createBooking(parsed.data));
  } catch (e) {
    // Task-10 correction 3: map on the typed error classes Task 8 built
    // (lib/idempotency.ts) with `instanceof`, never by matching on
    // `error.message` text — wording can change silently and break this.
    if (e instanceof IdempotencyFingerprintMismatchError) {
      // The same idempotency key was reused with a different request body.
      // This is a client bug; retrying unchanged will not help.
      return NextResponse.json(
        { error: 'Idempotency key was reused with a different request body' },
        { status: 422 },
      );
    }
    if (e instanceof IdempotencyInFlightError || e instanceof IdempotencyClaimExhaustedError) {
      // A concurrent request already holds (or is contending hard over)
      // this key. Both are retryable — the client can reasonably try again
      // shortly.
      return NextResponse.json({ error: 'Request already in progress' }, { status: 409 });
    }
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
