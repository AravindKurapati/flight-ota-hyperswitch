import 'server-only';
import { env } from './env';
import {
  type HsPayment, type HsRefund, type CreateIntentInput,
  type OffSessionInput, type RefundInput, HyperswitchError,
} from './hyperswitch.types';

export { HyperswitchError };

const BASE = 'https://sandbox.hyperswitch.io';

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'api-key': env.HYPERSWITCH_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if (!res.ok) {
    // Hyperswitch always returns a JSON error body on failure, but a
    // malformed one here is still an error either way: the HTTP status
    // alone is enough to raise a typed HyperswitchError, and defaulting the
    // body to {} cannot be mistaken for a real payment or refund.
    const errorBody = await res.json().catch(() => ({}));
    throw new HyperswitchError(
      `Hyperswitch ${method} ${path} failed with ${res.status}`,
      res.status,
      errorBody,
    );
  }

  // On the success path, a body that fails to parse must NOT default to {}.
  // Callers key off `payment_id` / `status`; a silent {} cast to T is
  // indistinguishable from a real (if empty) result and would swallow the
  // failure. Surface it as a typed HyperswitchError instead.
  const rawText = await res.text();
  try {
    return (rawText ? JSON.parse(rawText) : {}) as T;
  } catch {
    throw new HyperswitchError(
      `Hyperswitch ${method} ${path} returned ${res.status} with a response body that could not be parsed as JSON`,
      res.status,
      rawText,
    );
  }
}

export async function createIntent(input: CreateIntentInput): Promise<HsPayment> {
  const sum = input.orderDetails.reduce((acc, d) => acc + d.amount * d.quantity, 0);
  if (sum !== input.amountMinor) {
    throw new Error(
      `order_details sum ${sum} does not equal amount ${input.amountMinor}; Hyperswitch will reject this`,
    );
  }
  return call<HsPayment>('/payments', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    currency: 'USD',
    confirm: false,
    capture_method: input.captureMethod,
    authentication_type: 'no_three_ds',
    profile_id: env.HYPERSWITCH_PROFILE_ID,
    customer_id: input.customerId,
    description: input.description,
    order_details: input.orderDetails,
    return_url: input.returnUrl,
    ...(input.setupFutureUsage ? { setup_future_usage: input.setupFutureUsage } : {}),
  });
}

export function getPayment(hsPaymentId: string): Promise<HsPayment> {
  return call<HsPayment>(`/payments/${hsPaymentId}`, undefined, 'GET');
}

export function capture(hsPaymentId: string, amountMinor: number): Promise<HsPayment> {
  return call<HsPayment>(`/payments/${hsPaymentId}/capture`, {
    amount_to_capture: amountMinor,
  });
}

export function voidPayment(hsPaymentId: string, reason: string): Promise<HsPayment> {
  return call<HsPayment>(`/payments/${hsPaymentId}/cancel`, {
    cancellation_reason: reason,
  });
}

export function refund(input: RefundInput): Promise<HsRefund> {
  return call<HsRefund>('/refunds', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    reason: input.reason,
  });
}

export function chargeOffSession(input: OffSessionInput): Promise<HsPayment> {
  return call<HsPayment>('/payments', {
    payment_id: input.hsPaymentId,
    amount: input.amountMinor,
    currency: 'USD',
    confirm: true,
    off_session: true,
    capture_method: 'automatic',
    profile_id: env.HYPERSWITCH_PROFILE_ID,
    customer_id: input.customerId,
    description: input.description,
    recurring_details: {
      type: 'payment_method_id',
      data: input.paymentMethodId,
    },
  });
}
