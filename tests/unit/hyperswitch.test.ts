import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('hyperswitch client', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('refuses to send order_details that do not sum to amount', async () => {
    const { createIntent } = await import('../../lib/hyperswitch');
    await expect(
      createIntent({
        hsPaymentId: 'pay_' + '0'.repeat(26),
        amountMinor: 65400,
        captureMethod: 'manual',
        customerId: 'cus_1',
        description: 'x',
        orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
        returnUrl: 'https://example.com',
      }),
    ).rejects.toThrow(/does not equal amount/);
  });

  it('does not call fetch when the order_details sum check fails', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { createIntent } = await import('../../lib/hyperswitch');
    await expect(
      createIntent({
        hsPaymentId: 'pay_' + '0'.repeat(26),
        amountMinor: 65400,
        captureMethod: 'manual',
        customerId: 'cus_1',
        description: 'x',
        orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
        returnUrl: 'https://example.com',
      }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('always sends no_three_ds and an explicit capture_method', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'x', status: 'requires_confirmation' }), { status: 200 }),
    );
    const { createIntent } = await import('../../lib/hyperswitch');
    await createIntent({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 50000,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'x',
      orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
      returnUrl: 'https://example.com',
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.authentication_type).toBe('no_three_ds');
    expect(body.capture_method).toBe('manual');
    expect(body.profile_id).toBeTruthy();
  });

  it('builds the createIntent request with the correct URL, method, headers and minor-unit body', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'x', status: 'requires_confirmation' }), { status: 200 }),
    );
    const { createIntent } = await import('../../lib/hyperswitch');
    const hsPaymentId = 'pay_' + '0'.repeat(26);
    await createIntent({
      hsPaymentId,
      amountMinor: 65400,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'JFK-LAX one way',
      orderDetails: [
        { product_name: 'Fare', quantity: 1, amount: 50000 },
        { product_name: 'Taxes and fees', quantity: 1, amount: 15400 },
      ],
      returnUrl: 'https://example.com/return',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.hyperswitch.io/payments');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['api-key']).toBe(process.env.HYPERSWITCH_API_KEY);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      payment_id: hsPaymentId,
      amount: 65400,
      currency: 'USD',
      confirm: false,
      capture_method: 'manual',
      authentication_type: 'no_three_ds',
      customer_id: 'cus_1',
      description: 'JFK-LAX one way',
      return_url: 'https://example.com/return',
    });
    expect(Number.isInteger(body.amount)).toBe(true);
    expect(body.order_details).toEqual([
      { product_name: 'Fare', quantity: 1, amount: 50000 },
      { product_name: 'Taxes and fees', quantity: 1, amount: 15400 },
    ]);
    // setup_future_usage was not requested, so it must be omitted entirely, not sent as undefined
    expect('setup_future_usage' in body).toBe(false);
  });

  it('includes setup_future_usage only when requested', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'x', status: 'requires_confirmation' }), { status: 200 }),
    );
    const { createIntent } = await import('../../lib/hyperswitch');
    await createIntent({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 50000,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'x',
      orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
      returnUrl: 'https://example.com',
      setupFutureUsage: 'off_session',
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.setup_future_usage).toBe('off_session');
  });

  it('parses a successful createIntent response into HsPayment fields', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_id: 'pay_abc',
          status: 'requires_capture',
          connector: 'stripe',
          client_secret: 'secret_123',
          amount: 65400,
          amount_capturable: 65400,
          amount_received: null,
          payment_method_id: null,
          error_message: null,
          error_code: null,
        }),
        { status: 200 },
      ),
    );
    const { createIntent } = await import('../../lib/hyperswitch');
    const result = await createIntent({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 65400,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'x',
      orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 65400 }],
      returnUrl: 'https://example.com',
    });
    expect(result).toEqual({
      payment_id: 'pay_abc',
      status: 'requires_capture',
      connector: 'stripe',
      client_secret: 'secret_123',
      amount: 65400,
      amount_capturable: 65400,
      amount_received: null,
      payment_method_id: null,
      error_message: null,
      error_code: null,
    });
  });

  it('surfaces a non-2xx response as a typed HyperswitchError carrying status and body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'card declined', code: 'card_declined' } }),
        { status: 402 },
      ),
    );
    const { createIntent, HyperswitchError } = await import('../../lib/hyperswitch');
    const call = createIntent({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 50000,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'x',
      orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
      returnUrl: 'https://example.com',
    });
    await expect(call).rejects.toBeInstanceOf(HyperswitchError);
    try {
      await call;
      expect.unreachable('createIntent should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HyperswitchError);
      const hsErr = err as InstanceType<typeof HyperswitchError>;
      expect(hsErr.status).toBe(402);
      expect(hsErr.body).toEqual({ error: { message: 'card declined', code: 'card_declined' } });
      expect(hsErr.message).toMatch(/402/);
    }
  });

  it('does not throw an unhandled rejection when a non-2xx response has an unparsable body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not json', { status: 500 }));
    const { createIntent, HyperswitchError } = await import('../../lib/hyperswitch');
    const call = createIntent({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 50000,
      captureMethod: 'manual',
      customerId: 'cus_1',
      description: 'x',
      orderDetails: [{ product_name: 'Fare', quantity: 1, amount: 50000 }],
      returnUrl: 'https://example.com',
    });
    await expect(call).rejects.toBeInstanceOf(HyperswitchError);
    try {
      await call;
    } catch (err) {
      const hsErr = err as InstanceType<typeof HyperswitchError>;
      expect(hsErr.status).toBe(500);
      expect(hsErr.body).toEqual({});
    }
  });

  it('getPayment issues a GET to /payments/{id} with no body', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'pay_abc', status: 'requires_capture' }), { status: 200 }),
    );
    const { getPayment } = await import('../../lib/hyperswitch');
    await getPayment('pay_abc');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.hyperswitch.io/payments/pay_abc');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('capture posts amount_to_capture in minor units to /payments/{id}/capture', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'pay_abc', status: 'succeeded' }), { status: 200 }),
    );
    const { capture } = await import('../../lib/hyperswitch');
    await capture('pay_abc', 65400);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.hyperswitch.io/payments/pay_abc/capture');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ amount_to_capture: 65400 });
    expect(Number.isInteger(body.amount_to_capture)).toBe(true);
  });

  it('voidPayment posts cancellation_reason to /payments/{id}/cancel', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'pay_abc', status: 'cancelled' }), { status: 200 }),
    );
    const { voidPayment } = await import('../../lib/hyperswitch');
    await voidPayment('pay_abc', 'ticketing_failed');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.hyperswitch.io/payments/pay_abc/cancel');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ cancellation_reason: 'ticketing_failed' });
  });

  it('refund posts payment_id, minor-unit amount and reason to /refunds', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ refund_id: 'ref_1', payment_id: 'pay_abc', amount: 15400, status: 'succeeded' }), {
        status: 200,
      }),
    );
    const { refund } = await import('../../lib/hyperswitch');
    const result = await refund({ hsPaymentId: 'pay_abc', amountMinor: 15400, reason: 'schedule_change' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.hyperswitch.io/refunds');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ payment_id: 'pay_abc', amount: 15400, reason: 'schedule_change' });
    expect(result).toEqual({ refund_id: 'ref_1', payment_id: 'pay_abc', amount: 15400, status: 'succeeded' });
  });

  it('chargeOffSession confirms immediately with automatic capture and a stored payment method', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ payment_id: 'pay_abc', status: 'succeeded' }), { status: 200 }),
    );
    const { chargeOffSession } = await import('../../lib/hyperswitch');
    await chargeOffSession({
      hsPaymentId: 'pay_' + '0'.repeat(26),
      amountMinor: 2500,
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      description: 'Extra bag',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.hyperswitch.io/payments');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      amount: 2500,
      currency: 'USD',
      confirm: true,
      off_session: true,
      capture_method: 'automatic',
      customer_id: 'cus_1',
      description: 'Extra bag',
    });
    expect(body.profile_id).toBeTruthy();
    expect(body.recurring_details).toEqual({ type: 'payment_method_id', data: 'pm_1' });
  });
});
