/**
 * Seeds one booking in each demonstrable state against the LIVE sandbox, so
 * the ops console is populated at the start of a walkthrough:
 *
 *   1. AUTHORIZED           — awaiting issuance (itin_sfo_jfk)
 *   2. TICKETED             — issued and captured (itin_sfo_jfk)
 *   3. VOIDED               — terminal issuance failure (itin_bos_sea)
 *   4. PARTIALLY_REFUNDED   — issued, then partially refunded (itin_sfo_jfk)
 *
 * Everything goes through the real code paths — createBooking, issueTicket,
 * refundBooking, syncAuthorization — never hand-crafted database rows: the
 * seed data must be exactly as real as anything a traveller produces.
 *
 * The one step the library deliberately has no server-side function for is
 * confirming the flight payment (in production that is the traveller, in the
 * browser, via the Hyperswitch SDK — Task 11). The seed confirms via
 * `POST /payments/{id}/confirm` with Hyperswitch's published test card,
 * exactly the server-side-confirm pattern scripts/smoke.ts established
 * (V-001) — acceptable against this sandbox, never against production keys.
 *
 * Run on demo day, not before: fauxpay payments expire after two days
 * (DECISIONS.md deferred-items table), so early-seeded data goes stale.
 *
 * Usage: npm run seed
 * (runs tsx with --conditions=react-server so `import 'server-only'` inside
 * lib/ modules resolves to its no-op react-server build)
 */
import { eq, and } from 'drizzle-orm';
import { db, bookings, payments } from '../db';
import {
  createBooking, issueTicket, refundBooking, syncAuthorization,
} from '../lib/bookings';

const BASE = 'https://sandbox.hyperswitch.io';
const KEY = process.env.HYPERSWITCH_API_KEY!;

if (!KEY) {
  console.error('Missing HYPERSWITCH_API_KEY. Run via `npm run seed` (loads .env).');
  process.exit(1);
}

async function confirmFlightPayment(bookingId: string): Promise<void> {
  const [row] = await db.select().from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'flight')));
  if (!row) throw new Error(`No flight payment for booking ${bookingId}`);

  const res = await fetch(`${BASE}/payments/${row.hsPaymentId}/confirm`, {
    method: 'POST',
    headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_method: 'card',
      payment_method_type: 'credit',
      payment_method_data: {
        card: {
          card_number: '4242424242424242',
          card_exp_month: '12',
          card_exp_year: '2030',
          card_cvc: '123',
          card_holder_name: 'Seed Traveller',
        },
      },
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`confirm ${row.hsPaymentId} -> ${res.status} ${JSON.stringify(body)}`);
  }
  if (body.status !== 'requires_capture') {
    throw new Error(
      `confirm ${row.hsPaymentId}: expected requires_capture, got ${body.status} ` +
      `(${body.error_code ?? ''} ${body.error_message ?? ''})`,
    );
  }
}

async function bookAndAuthorize(itineraryId: string, label: string): Promise<string> {
  const { bookingId } = await createBooking({
    itineraryId,
    passengers: [{ firstName: 'Seed', lastName: label }],
    idempotencyKey: `seed_${label}_${Date.now()}`,
  });
  await confirmFlightPayment(bookingId);
  const { state } = await syncAuthorization(bookingId);
  if (state !== 'AUTHORIZED') {
    throw new Error(`booking ${bookingId}: expected AUTHORIZED after confirm, got ${state}`);
  }
  return bookingId;
}

async function main() {
  console.log('1. AUTHORIZED — awaiting issuance');
  const authorized = await bookAndAuthorize('itin_sfo_jfk', 'Authorized');
  console.log('   booking:', authorized);

  console.log('2. TICKETED — issued and captured');
  const ticketed = await bookAndAuthorize('itin_sfo_jfk', 'Ticketed');
  const issued = await issueTicket(ticketed);
  if (issued.state !== 'TICKETED') throw new Error(`expected TICKETED, got ${issued.state}`);
  console.log('   booking:', ticketed, 'ticket:', issued.ticketNumber);

  console.log('3. VOIDED — terminal issuance failure (itin_bos_sea)');
  const doomed = await bookAndAuthorize('itin_bos_sea', 'Voided');
  const voided = await issueTicket(doomed);
  if (voided.state !== 'VOIDED') throw new Error(`expected VOIDED, got ${voided.state}`);
  console.log('   booking:', doomed);

  console.log('4. PARTIALLY_REFUNDED — issued, then $50.00 refunded');
  const refundable = await bookAndAuthorize('itin_sfo_jfk', 'Refunded');
  const issued2 = await issueTicket(refundable);
  if (issued2.state !== 'TICKETED') throw new Error(`expected TICKETED, got ${issued2.state}`);
  const refunded = await refundBooking({
    bookingId: refundable, amountMinor: 5000, reason: 'seed_partial_refund',
  });
  if (refunded.state !== 'PARTIALLY_REFUNDED') {
    throw new Error(`expected PARTIALLY_REFUNDED, got ${refunded.state}`);
  }
  console.log('   booking:', refundable);

  console.log('\nSEED COMPLETE — open /ops to see all four states.');
}

main()
  .catch((e) => {
    console.error('\nSEED FAILED:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await (db.$client as { end: () => Promise<void> }).end();
  });
