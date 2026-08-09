import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, bookings, payments } from '../../../../db';
import { getPayment } from '../../../../lib/hyperswitch';

// Demo simplification: one live Hyperswitch call per booking on every load.
// Fine at a 25-row limit and demo traffic; a production version would rely
// on webhook-driven state (Task 12) and only spot-check live state on
// demand, not on every poll.
export async function GET() {
  const rows = await db.select().from(bookings).orderBy(desc(bookings.createdAt)).limit(25);

  const enriched = await Promise.all(rows.map(async (b) => {
    const [p] = await db.select().from(payments).where(eq(payments.bookingId, b.id));
    let live: string | null = null;
    try {
      live = p ? (await getPayment(p.hsPaymentId)).status : null;
    } catch {
      live = 'unreachable';
    }
    return {
      ...b,
      hsPaymentId: p?.hsPaymentId ?? null,
      connector: p?.connector ?? null,
      storedPaymentState: p?.state ?? null,
      livePaymentState: live,
      // D-011 made visible: reconciliation is surfaced, not automated.
      diverged: p ? live !== p.state : false,
    };
  }));

  return NextResponse.json(enriched);
}
