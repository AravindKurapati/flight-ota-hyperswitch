import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { chargeAncillary } from '../../../../../lib/bookings';
import {
  IdempotencyFingerprintMismatchError,
  IdempotencyInFlightError,
  IdempotencyClaimExhaustedError,
} from '../../../../../lib/idempotency';

const schema = z.object({
  description: z.string().min(1),
  amountMinor: z.number().int().positive(),
  idempotencyKey: z.string().min(8),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    return NextResponse.json(await chargeAncillary({ bookingId: id, ...parsed.data }));
  } catch (e) {
    if (e instanceof IdempotencyFingerprintMismatchError) {
      return NextResponse.json(
        { error: 'Idempotency key was reused with a different request body' },
        { status: 422 },
      );
    }
    if (e instanceof IdempotencyInFlightError || e instanceof IdempotencyClaimExhaustedError) {
      return NextResponse.json({ error: 'Charge already in progress' }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
