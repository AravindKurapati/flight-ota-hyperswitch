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
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HyperswitchError(
      `Hyperswitch ${method} ${path} failed with ${res.status}`,
      res.status,
      json,
    );
  }
  return json as T;
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
