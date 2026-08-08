import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, payments } from '../../../../db';
import { verifySignature } from '../../../../lib/webhooks';
import { recordEvent } from '../../../../lib/events';
import { assertCapableOrThrow, ConnectorCapabilityError } from '../../../../lib/connector-capabilities';
import { voidPayment } from '../../../../lib/hyperswitch';

/** Statuses ordered by progress. A webhook never moves a payment backwards. */
const RANK: Record<string, number> = {
  requires_payment_method: 0, requires_confirmation: 1, requires_customer_action: 2,
  processing: 3, requires_capture: 4, partially_captured: 5,
  succeeded: 6, cancelled: 7, failed: 7,
};

// A payment already at rank >= this has no further capture/void action to
// take -- succeeded, cancelled, or failed. Used to guard against voiding a
// payment twice on a duplicate/retried webhook delivery.
const TERMINAL_RANK = RANK.succeeded;

function alreadyTerminal(state: string): boolean {
  return (RANK[state] ?? -1) >= TERMINAL_RANK;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get('x-webhook-signature-512') ?? '';

  if (!verifySignature(raw, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // The signature is verified, but a correctly-signed body is not
  // guaranteed to be valid JSON (nothing stops a byte-for-byte HMAC over
  // garbage). Never let a parse failure crash the handler -- there is
  // nothing to act on, and a non-2XX here just buys a pointless 24h retry
  // storm from Hyperswitch for a payload we could never have understood.
  // `any` here follows JSON.parse's own return type; every field pulled off
  // it below is read defensively (optional chaining, explicit undefined
  // checks), not assumed to exist.
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const hsPaymentId: string | undefined = event?.content?.object?.payment_id;
  const status: string | undefined = event?.content?.object?.status;
  if (!hsPaymentId || !status) return NextResponse.json({ ok: true });

  // Correction 1 (D-007 finally wired): the webhook payload's exact shape
  // for `connector` is UNVERIFIED this session -- Exa was offline and there
  // is no live-reachable endpoint yet to observe a real delivery against.
  // HsPayment (lib/hyperswitch.types.ts, verified live in Task 6) has
  // `connector: string | null` on the plain payments API response, and the
  // brief's own already-established assumption is that the full resource is
  // wrapped under `content.object` -- so `content.object.connector` is a
  // reasonable, but not certain, guess. See DECISIONS.md.
  //
  // The three-way read matters: `undefined` means the field is genuinely
  // absent from this payload (a real possibility once this runs against a
  // live delivery) and the capability check is skipped entirely for this
  // event -- asserting against `null` would treat "we don't know" as "we
  // confirmed no connector," which would fire a false capability violation
  // on every single webhook if the field simply isn't there. A present
  // `null`, by contrast, is meaningful: Hyperswitch can legitimately report
  // `connector: null` before routing has run, and that IS worth checking.
  const connector: string | null | undefined = event?.content?.object?.connector;

  const [row] = await db.select().from(payments).where(eq(payments.hsPaymentId, hsPaymentId));
  if (!row) return NextResponse.json({ ok: true }); // not ours; acknowledge anyway

  if (connector !== undefined) {
    try {
      assertCapableOrThrow(connector, row.kind);
    } catch (err) {
      // A flight or protection payment landed on a connector that cannot
      // support it -- should never happen given the D-005/D-006 routing
      // rules, but D-007 exists precisely as defense against exactly this.
      // Void it (unless a previous delivery of this same event already did,
      // which the terminal-state check below prevents double-doing) and
      // record it durably. Still return 200: Hyperswitch cannot fix this by
      // retrying delivery, and we now have a queryable record instead.
      //
      // `assertCapableOrThrow` only ever throws `ConnectorCapabilityError`,
      // but this is read defensively rather than assumed -- an unexpected
      // throw here still must not crash the handler or skip the audit
      // record, which is the entire point of this branch existing.
      const capErr = err instanceof ConnectorCapabilityError ? err : null;
      const reason = err instanceof Error ? err.message : String(err);
      const missing = capErr?.missing ?? [];
      let voided = false;
      let voidError: string | undefined;

      if (!alreadyTerminal(row.state)) {
        // The Hyperswitch call itself can fail (network, 5xx, timeout) --
        // that must not propagate out of the handler as an unhandled
        // rejection. A crash here would mean the ONE branch that exists to
        // catch a real, dangerous misrouting loses its audit trail entirely,
        // which is the opposite of what "always ack 200" is for.
        try {
          const result = await voidPayment(hsPaymentId, 'connector_capability_violation');
          await db
            .update(payments)
            .set({ connector, state: result.status, updatedAt: new Date() })
            .where(eq(payments.id, row.id));
          voided = true;
        } catch (voidErr) {
          voidError = voidErr instanceof Error ? voidErr.message : String(voidErr);
          if (connector !== row.connector) {
            // The void didn't happen, but the connector value is still
            // worth persisting truthfully (Correction 4).
            await db
              .update(payments)
              .set({ connector, updatedAt: new Date() })
              .where(eq(payments.id, row.id));
          }
        }
      } else if (connector !== row.connector) {
        // Nothing to void, but the connector value is still worth
        // persisting truthfully (Correction 4).
        await db
          .update(payments)
          .set({ connector, updatedAt: new Date() })
          .where(eq(payments.id, row.id));
      }

      await recordEvent(row.bookingId, 'capability.violation', {
        connector, kind: row.kind, reason, missing, voided,
        ...(voidError ? { voidError } : {}),
      });
      await recordEvent(row.bookingId, 'webhook.received', {
        hsPaymentId, status, eventId: event?.event_id ?? null,
      });
      return NextResponse.json({ ok: true });
    }
  }

  // Capability check passed, or the payload didn't carry a `connector`
  // field at all (nothing to check). Proceed with the normal monotonic
  // state-advance. Webhooks are unordered and may duplicate, so a late
  // 'succeeded' must not overwrite a later 'cancelled'.
  const patch: Record<string, unknown> = {};
  // Correction 4: only write `connector` when this event actually carries a
  // non-undefined value for it. A later webhook that omits the field must
  // never null out a connector value a previous webhook already correctly
  // set.
  if (connector !== undefined) patch.connector = connector;
  if ((RANK[status] ?? -1) > (RANK[row.state] ?? -1)) patch.state = status;
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date();
    await db.update(payments).set(patch).where(eq(payments.id, row.id));
  }

  await recordEvent(row.bookingId, 'webhook.received', {
    hsPaymentId, status, eventId: event?.event_id ?? null,
  });
  return NextResponse.json({ ok: true });
}
