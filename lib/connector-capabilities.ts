import type { PaymentKind } from '../db/schema';

export type Capability = {
  capture: boolean;
  void: boolean;
  mit: boolean;
  webhooks: boolean;
};

const NONE: Capability = { capture: false, void: false, mit: false, webhooks: false };

/**
 * Static connector capability table (D-007). Routing decides which connector handles a
 * payment; this table lets us check, after authorization, whether that connector can
 * actually do what the payment kind will need. A flight landing on a connector that
 * cannot capture is voided immediately rather than stranding the traveller's money with
 * no API path to release it — see D-006.
 *
 * The evidence behind each row is not uniform. Comments say, field by field, whether a
 * value is verified against the live sandbox or established from reading connector
 * source only. Treat "source only" as credible, not as equivalent to a live probe.
 *
 * ---
 *
 * `authorizedotnet` — the capture-capable connector since D-012.
 *   - capture: VERIFIED LIVE (V-001, DECISIONS.md, run via scripts/smoke.ts). Authorized
 *     $654.00 with capture_method: manual -> requires_capture, amount_capturable: 65400;
 *     then captured amount_to_capture: 60000 -> partially_captured, amount_received: 60000.
 *   - void: VERIFIED LIVE (V-001). POST /payments/{id}/cancel on an authorized,
 *     uncaptured payment -> cancelled.
 *   - mit: SOURCE ONLY, not exercised live. authorizedotnet.rs:296 has a real
 *     `impl ConnectorIntegration<SetupMandate, ...>`, and the transformers handle both
 *     NetworkMandateId and ConnectorMandateId. Credible, but no MIT payment has actually
 *     been run against the sandbox yet.
 *   - webhooks: SOURCE ONLY, not exercised live. No webhook has been received from this
 *     connector yet.
 *
 * `stripe` — NOT USED HERE. Kept as a documented row, not dead code: D-012 found that
 *   Hyperswitch's Stripe connector sends the raw PAN on the secret-key path
 *   (`payment_method_data[card][number]` to v1/payment_intents, authenticated with
 *   `Bearer {secret_key}` — stripe/transformers.rs:310, stripe.rs:157) and Stripe blocks
 *   that on a new account by default. Lifting the block needs full business activation
 *   (legal entity, tax details, an account representative's SSN, a bank account), which
 *   the project rules place on the deferred list — that is a credentialing problem, not
 *   a capability one. The values below are what Stripe can do in principle; do not read
 *   `false` anywhere in this row, because there isn't one — Stripe can capture, void,
 *   run MIT and deliver webhooks. It is simply not reachable from this project.
 *
 * `fauxpay` / `phonypay` / `pretendpay` — Hyperswitch's dummy connector family, all
 *   backed by the same crates/hyperswitch_connectors/src/connectors/dummyconnector.rs.
 *   All false, VERIFIED FROM SOURCE:
 *   - capture: get_url() and get_request_body() both return NotImplemented, and
 *     build_request() calls get_url() — there is no working request path at all.
 *   - void: an empty trait impl.
 *   - mit: SetupMandate is explicitly NotImplemented.
 *   - webhooks: returns WebhooksNotImplemented.
 *   This is the entire reason D-007 exists: fauxpay will happily authorize a payment
 *   and then has no working capture or void endpoint, so funds land with no way back.
 */
const TABLE: Record<string, Capability> = {
  authorizedotnet: { capture: true, void: true, mit: true, webhooks: true },
  stripe: { capture: true, void: true, mit: true, webhooks: true },
  fauxpay: NONE,
  phonypay: NONE,
  pretendpay: NONE,
};

/**
 * What each payment kind needs from its connector — independent of which connector
 * routing actually picks. Kept explicit here, as data, so "what does a flight need"
 * is readable directly rather than reverse-engineered out of conditionals.
 */
const REQUIREMENTS: Record<PaymentKind, (keyof Capability)[]> = {
  // Authorize now, capture once a ticket exists, void on issuance failure or a DOT
  // 24-hour cancellation (D-002, D-003, D-004).
  flight: ['capture', 'void'],
  // Auto-captures at authorization time and needs nothing beyond that — which is
  // exactly why fauxpay, which can authorize but nothing else, is an acceptable
  // connector for it (D-005).
  protection: [],
  // Off-session charge against a stored payment method after the traveller has left
  // checkout (merchant-initiated transaction).
  ancillary: ['mit'],
};

/**
 * Looks up what a connector can do. Unknown connectors — including one that has never
 * been added to this table, and `null`, which Hyperswitch's payment response can
 * legitimately return — resolve to no capabilities at all. This must fail closed: a
 * new PSP appearing here should never silently inherit permission to hold a
 * traveller's money because someone forgot to add a row.
 */
export function capabilitiesFor(connector: string | null): Capability {
  if (connector === null) return NONE;
  return TABLE[connector] ?? NONE;
}

/**
 * Throws unless `connector` supports everything `kind` will need over the life of the
 * payment. Callers use this right after authorization to decide whether to proceed or
 * void immediately (D-007) — by the time capture or void is actually attempted and
 * fails, the traveller-facing failure mode is already the bad one.
 */
export function assertCapableOrThrow(connector: string | null, kind: PaymentKind): void {
  const caps = capabilitiesFor(connector);
  const missing = REQUIREMENTS[kind].filter((capability) => !caps[capability]);
  if (missing.length > 0) {
    throw new Error(
      `Connector "${connector ?? 'null'}" cannot support a "${kind}" payment: ` +
        `missing ${missing.join(', ')}. Void immediately rather than stranding funds ` +
        `on a connector with no path to release them.`,
    );
  }
}
