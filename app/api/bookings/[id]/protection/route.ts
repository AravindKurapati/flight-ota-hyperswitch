import { NextRequest, NextResponse } from 'next/server';
import { addTripProtection } from '../../../../../lib/bookings';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await addTripProtection(id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
