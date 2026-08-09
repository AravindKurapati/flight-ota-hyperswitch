import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { refundBooking } from '../../../../../lib/bookings';
import {
  IdempotencyFingerprintMismatchError,
  IdempotencyInFlightError,
  IdempotencyClaimExhaustedError,
} from '../../../../../lib/idempotency';

const schema = z.object({
  amountMinor: z.number().int().positive(),
  reason: z.string().min(1),
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
    return NextResponse.json(await refundBooking({ bookingId: id, ...parsed.data }));
  } catch (e) {
    if (e instanceof IdempotencyFingerprintMismatchError) {
      // Same (payment, reason) key reused with a different amount — a repeat
      // refund for the same reason must be byte-identical or it's a client bug.
      return NextResponse.json(
        { error: 'A refund with this reason was already requested with a different amount' },
        { status: 422 },
      );
    }
    if (e instanceof IdempotencyInFlightError || e instanceof IdempotencyClaimExhaustedError) {
      return NextResponse.json({ error: 'Refund already in progress' }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
