export type HsPayment = {
  payment_id: string;
  status: string;
  connector: string | null;
  client_secret: string | null;
  amount: number;
  amount_capturable: number;
  amount_received: number | null;
  payment_method_id: string | null;
  error_message: string | null;
  error_code: string | null;
};

export type HsRefund = {
  refund_id: string;
  payment_id: string;
  amount: number;
  status: string;
  /** Connector's failure reason when status is 'failed' — e.g. Authorize.net
   * error 54, "does not meet the criteria for issuing a credit" (an
   * unsettled capture cannot be credited). Observed live, V-005. */
  error_message?: string | null;
};

export type OrderDetail = {
  product_name: string;
  quantity: number;
  amount: number;
};

export type CreateIntentInput = {
  hsPaymentId: string;
  amountMinor: number;
  captureMethod: 'manual' | 'automatic';
  customerId: string;
  description: string;
  orderDetails: OrderDetail[];
  setupFutureUsage?: 'off_session';
  returnUrl: string;
};

export type DummyAutoChargeInput = {
  hsPaymentId: string;
  amountMinor: number;
  customerId: string;
  description: string;
  orderDetails: OrderDetail[];
};

export type OffSessionInput = {
  hsPaymentId: string;
  amountMinor: number;
  customerId: string;
  paymentMethodId: string;
  description: string;
};

export type RefundInput = {
  hsPaymentId: string;
  amountMinor: number;
  reason: string;
  /**
   * Merchant-supplied refund identifier, passed through as `refund_id`.
   * Same idempotency-by-owned-identifier pattern as `hs_payment_id` (D-010):
   * Hyperswitch's POST /refunds accepts it, verified against
   * api-reference.hyperswitch.io (Task 6 follow-up, closed in Task 15).
   */
  refundId?: string;
};

export class HyperswitchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'HyperswitchError';
  }
}
