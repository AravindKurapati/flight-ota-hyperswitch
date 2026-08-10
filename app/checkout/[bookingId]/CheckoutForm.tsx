'use client';
import { useState } from 'react';
import { useHyper, UnifiedCheckout } from '@juspay-tech/react-hyper-js';

/**
 * Task-11 correction 3 / known documentation inconsistency, resolved.
 *
 * The official guide's own two sentences contradict each other: it
 * initialises `const widgets = useWidgets()` but then calls
 * `hyper.confirmPayment({ elements, ... })` — neither the variable named
 * nor the field passed match. Two independent signals resolved this without
 * guessing:
 *
 *   1. `@juspay-tech/hyper-js`'s shipped `dist/index.d.ts` declares
 *      `confirmPayment(params: confirmPaymentInputPayload)` where
 *      `confirmPaymentInputPayload` has exactly two optional fields —
 *      `confirmParams` and `redirect`. No `elements`, no `widgets`.
 *   2. Reading `@juspay-tech/react-hyper-js`'s compiled bundle
 *      (dist/index.mjs — it ships no source maps or readable source, only
 *      this minified output) directly: `useHyper()`'s `confirmPayment` is
 *      not a wrapper — it is `HyperInstance.confirmPayment` from the
 *      resolved `hyper` promise, assigned straight onto the context value
 *      with no extra parameter threaded through. There is nothing in the
 *      compiled code that reads a `widgets` or `elements` field off the
 *      payload at all.
 *
 * HAND-TESTED (see task-11-report.md): calling `confirmPayment({
 * confirmParams, redirect })` with no widgets/elements field submitted the
 * card mounted by <UnifiedCheckout> below and produced a real state
 * transition against the live sandbox — `requires_capture` on the success
 * path, confirmed via both the confirmation page's live read-back and a
 * direct API check. `widgets` was never added — the empirical result
 * matches what both signals predicted. Recorded as D-015 in DECISIONS.md.
 *
 * The decline branch below (billing ZIP 46282, DECISIONS.md V-001) could
 * NOT be hand-tested this session: this account's live `required_fields`
 * schema for card payments does not include a billing/AVS field, so
 * <UnifiedCheckout> never collects one, and neither a Stripe-shaped
 * `options` guess nor passing `billing` through `confirmParams` changed
 * that (both tried, both had no effect — see D-016). The branch is written
 * to the documented response shapes and is structurally correct, but is
 * unverified against a real decline in the browser.
 */
export function CheckoutForm({ bookingId }: { bookingId: string }) {
  const hyper = useHyper();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wantsProtection, setWantsProtection] = useState(false);
  // Set once the protection charge succeeds so a retried submit (e.g. after
  // a card decline on the flight leg) never attempts a second $24 charge —
  // the server's (booking_id, kind) unique index would reject it anyway,
  // but the traveller shouldn't see that as an error.
  const [protectionAdded, setProtectionAdded] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Double-click guard, layer one. The server guard in Task 10
    // (withIdempotency / the payments_one_per_kind_idx partial unique
    // index) is the one that actually protects us; this exists so the
    // traveller never sees a second request fired at all. `hyper` itself is
    // never null/undefined here — useHyper()'s context always provides an
    // object (verified in the compiled bundle: the default context value
    // has real, if stub, methods) — but that claim was never independently
    // reproduced the way D-016's `required_fields` finding was, and neither
    // hand-tested path exercised a click before `HyperElements` had
    // resolved. The try/catch below is what actually protects against that
    // edge case (and any other `confirmPayment` failure) regardless of
    // whether the stub-methods claim holds, so no separate null-check is
    // needed on top of it (review finding, task-11).
    if (submitting) return;
    setSubmitting(true);
    setMessage(null);

    // Trip protection first (Task 17, D-022): it's an independent payment,
    // and charging it before the flight confirm means a protection failure
    // can't strand an already-confirmed flight payment behind it. On
    // failure: show the error, untick the box, and stop — the traveller
    // retries the flight payment without it. A failed $24 add-on must never
    // block the flight purchase.
    if (wantsProtection && !protectionAdded) {
      try {
        const res = await fetch(`/api/bookings/${bookingId}/protection`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`);
        }
        setProtectionAdded(true);
      } catch (err) {
        setWantsProtection(false);
        setMessage(
          `Trip protection could not be added (${err instanceof Error ? err.message : 'unknown error'}). ` +
          'Your card has not been charged for the flight — press Pay again to continue without protection.',
        );
        setSubmitting(false);
        return;
      }
    }

    try {
      const result = await hyper.confirmPayment({
        confirmParams: {
          return_url: `${window.location.origin}/confirmation/${bookingId}`,
        },
        redirect: 'if_required',
      });

      // `result` is a union: `ConfirmPaymentErrorResponse` (client-side
      // failure before any request reached Hyperswitch — malformed card
      // input) has an `error` field and no `status`. A real server round
      // trip comes back as a full `ConfirmPaymentResponse` with `status`
      // and, on a connector decline, populated `error_message`/
      // `error_code`. Both branches are handled; only the `error`-absent,
      // `status: succeeded` path (the success case) was hand-verified this
      // session — the decline branch is written to the documented response
      // shape, not observed live. See D-016 in DECISIONS.md and the
      // CheckoutForm module comment.
      if ('error' in result) {
        setMessage(result.error.message || 'Please check your card details and try again.');
        setSubmitting(false);
        return;
      }

      if (result.status !== 'succeeded' && result.status !== 'requires_capture') {
        // A decline lands here. The PaymentIntent stays reusable, so the
        // traveller can enter another card against the same intent and
        // Hyperswitch records it as attempt #2.
        setMessage(result.error_message || 'That card was declined. Please try another card.');
        setSubmitting(false);
        return;
      }

      window.location.href = `/confirmation/${bookingId}`;
    } catch {
      // A thrown/rejected confirmPayment — e.g. clicked before the SDK
      // finished loading, or a transport failure. Without this, `submitting`
      // would stay true forever: the button would be stuck on "Processing…"
      // with no way to recover short of a reload (review finding, task-11).
      setMessage('Something went wrong submitting your payment. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <UnifiedCheckout id="unified-checkout" options={{}} />
      <label className="protection-row">
        <input
          type="checkbox"
          checked={wantsProtection || protectionAdded}
          disabled={submitting || protectionAdded}
          onChange={(e) => setWantsProtection(e.target.checked)}
        />
        {protectionAdded ? 'Trip protection added ($24.00)' : 'Add trip protection ($24.00)'}
      </label>
      <button className="btn" type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Processing…' : 'Pay and hold my seat'}
      </button>
      {message && (
        <p className="form-error" role="alert">
          {message}
        </p>
      )}
      <p className="checkout-note">
        Your card is authorized now and charged only once your ticket is issued.
        Free cancellation within 24 hours.
      </p>
    </form>
  );
}
