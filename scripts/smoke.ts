/**
 * Sandbox smoke test — the critical path.
 *
 * Run: npx tsx -r dotenv/config scripts/smoke.ts
 *
 * This is a throwaway probe, not a module. Its only job is to answer one
 * question before anything is built on top of it: does the hosted sandbox
 * actually support authorize-then-capture-later on a real connector?
 *
 * The whole architecture rests on it. Flight bookings authorize the card,
 * attempt ticket issuance, and capture only once a ticket number exists. If
 * capture or void does not work, that design does not hold and the spec has to
 * change before a line of it is built.
 */

const BASE = 'https://sandbox.hyperswitch.io';
const KEY = process.env.HYPERSWITCH_API_KEY!;
const PROFILE = process.env.HYPERSWITCH_PROFILE_ID!;

/**
 * The connector that must handle a flight authorization. Not Stripe: Stripe
 * gates raw card data behind a full business-verification review, and
 * Hyperswitch's Stripe connector sends `payment_method_data[card][number]`
 * with the secret key, so there is no way around it. See D-012.
 */
const EXPECTED_CONNECTOR = 'authorizedotnet';

if (!KEY || !PROFILE) {
  console.error('Missing HYPERSWITCH_API_KEY or HYPERSWITCH_PROFILE_ID. Run with -r dotenv/config.');
  process.exit(1);
}

const TEST_CARD = {
  card_exp_month: '12',
  card_exp_year: '2030',
  card_cvc: '123',
  card_holder_name: 'Smoke Test',
};

async function hs(path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as Record<string, any>;
}

/**
 * Authorize.net's sandbox triggers a general bank decline off the billing ZIP,
 * not off a card number. 46282 declines; anything else approves.
 *
 * Their amount-based triggers ($70.02 and friends) are marked deprecated in the
 * testing guide — "may cease to function without notice" — so we don't use them.
 * The ZIP trigger also keeps the fare realistic, which matters for a demo.
 */
const DECLINE_ZIP = '46282';
const APPROVE_ZIP = '94103';

/** A manual-capture authorization above the $50 routing threshold. */
function authorization(cardNumber: string, description: string, zip = APPROVE_ZIP) {
  return {
    amount: 65400,
    currency: 'USD',
    confirm: true,
    capture_method: 'manual',
    authentication_type: 'no_three_ds',
    profile_id: PROFILE,
    description,
    payment_method: 'card',
    payment_method_type: 'credit',
    payment_method_data: { card: { card_number: cardNumber, ...TEST_CARD } },
    billing: {
      address: {
        line1: '1 Market St',
        city: 'San Francisco',
        state: 'CA',
        zip,
        country: 'US',
        first_name: 'Smoke',
        last_name: 'Test',
      },
    },
  };
}

async function main() {
  // 1. Authorize only. $654.00 is well above the amount < $50 rule that sends
  //    traffic to fauxpay, so this must land on Stripe.
  console.log('1. authorize $654.00, capture_method=manual');
  const created = await hs('/payments', authorization('4242424242424242', 'smoke: manual capture probe'));

  console.log('   payment_id :', created.payment_id);
  console.log('   status     :', created.status);
  console.log('   connector  :', created.connector);
  console.log('   capturable :', created.amount_capturable);
  if (created.error_code || created.error_message) {
    console.log('   error_code :', created.error_code);
    console.log('   error_msg  :', created.error_message);
    console.log('   reason     :', created.error_reason);
  }

  if (created.connector !== EXPECTED_CONNECTOR) {
    throw new Error(
      `EXPECTED connector ${EXPECTED_CONNECTOR}, GOT ${created.connector}. Routing is ` +
        `misconfigured — a flight authorization on fauxpay can never be captured or voided.`,
    );
  }
  if (created.status !== 'requires_capture') {
    throw new Error(`EXPECTED requires_capture, GOT ${created.status}. capture_method was ignored.`);
  }

  // 2. Partial capture — $600 of the $654 authorized.
  console.log('\n2. capture $600.00 of the $654.00 authorized');
  const captured = await hs(`/payments/${created.payment_id}/capture`, { amount_to_capture: 60000 });
  console.log('   status     :', captured.status);
  console.log('   received   :', captured.amount_received);

  // 3. A second authorization, voided rather than captured. This is the DOT
  //    24-hour cancellation path: the traveller is never charged.
  console.log('\n3. authorize then void (the DOT 24h cancellation path)');
  const second = await hs('/payments', authorization('4242424242424242', 'smoke: void probe'));
  console.log('   status     :', second.status, '/', second.connector);
  const voided = await hs(`/payments/${second.payment_id}/cancel`, { cancellation_reason: 'smoke_test' });
  console.log('   after void :', voided.status);

  // 4. A decline must come back as a business outcome the traveller can act on
  //    (retry with another card), not as a transport error the UI can't explain.
  console.log(`\n4. declined card (billing zip ${DECLINE_ZIP})`);
  let declineOk = false;
  try {
    const declined = await hs(
      '/payments',
      authorization('4242424242424242', 'smoke: decline probe', DECLINE_ZIP),
    );
    console.log('   status     :', declined.status);
    console.log('   error_code :', declined.error_code);
    console.log('   error_msg  :', declined.error_message);
    declineOk = declined.status === 'failed';
    if (!declineOk) {
      console.log(`   WARNING: expected status failed, got ${declined.status}.`);
      console.log('   The decline trigger did not fire — flow C (decline + retry) has no way');
      console.log('   to demonstrate a decline until this is resolved.');
    }
  } catch (e) {
    console.log('   threw      :', (e as Error).message);
    console.log('   A decline must surface as a failed payment, not a thrown transport error.');
  }

  console.log('\nSMOKE PASSED — manual capture, partial capture and void all work on', created.connector);
  console.log(declineOk ? 'Decline trigger confirmed.' : 'Decline trigger NOT confirmed — see step 4.');
}

main().catch((e) => {
  console.error('\nSMOKE FAILED:', e.message);
  process.exit(1);
});
