import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, payments } from '../../../../../db';
import { getPayment } from '../../../../../lib/hyperswitch';
import { env } from '../../../../../lib/env';

// Lets a page refresh mid-checkout resume the same Hyperswitch payment
// intent instead of creating a second one — the client_secret always comes
// from reading the intent back (getPayment), never from re-deriving or
// caching it, per D-011 ("ambiguous outcomes resolve by reading, never by
// retrying") and V-002 (verified live: GET /payments/{id} returns the same
// client_secret as the original create, for an unconfirmed payment).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Task-11 correction 5: params is a Promise on Next.js 16.3.0.
  const { id } = await params;

  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, id), eq(payments.kind, 'flight')));
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const intent = await getPayment(row.hsPaymentId);
  return NextResponse.json({
    clientSecret: intent.client_secret,
    // Task-11 correction 6: this IS the publishable key (pk_snd_...), not
    // the secret HYPERSWITCH_API_KEY. Sending it to the browser is
    // deliberate and correct — it's what loadHyper() needs client-side, and
    // publishable keys are designed to be public. lib/env.ts's
    // `import 'server-only'` guarantees this route handler (the only place
    // that reads it) runs server-side, so this is the one narrow, correct
    // place for it to cross the boundary. The secret API key never appears
    // in any response this app sends.
    publishableKey: env.HYPERSWITCH_PUBLISHABLE_KEY,
  });
}
