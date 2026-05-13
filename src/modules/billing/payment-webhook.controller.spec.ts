import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookSignatureInvalidError } from './domain/errors';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentService } from './payment.service';

// FINDINGS.md M2 (B22a) — invalid signature must propagate as 400 instead
// of being swallowed by the always-200 catch-all. Other (non-signature)
// processing errors still ack 200 to prevent provider retry storms.

class FakePaymentService {
  next: (() => Promise<unknown>) | null = null;
  calls = 0;
  setNext(fn: () => Promise<unknown>): void {
    this.next = fn;
  }
  processWebhook(): Promise<unknown> {
    this.calls += 1;
    if (!this.next) return Promise.resolve();
    return this.next();
  }
}

function makeReq(body: Record<string, unknown>): RawBodyRequest<Request> {
  return {
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
  } as unknown as RawBodyRequest<Request>;
}

describe('PaymentWebhookController (M2)', () => {
  let svc: FakePaymentService;
  let ctrl: PaymentWebhookController;

  beforeEach(() => {
    svc = new FakePaymentService();
    ctrl = new PaymentWebhookController(svc as unknown as PaymentService);
  });

  it('returns 200 ack on a successful processWebhook', async () => {
    svc.setNext(() => Promise.resolve());
    const res = await ctrl.webhook(
      'mock',
      { 'x-mock-signature': 'valid' },
      makeReq({ provider_payment_id: 'p1', status: 'completed' }),
    );
    expect(res).toEqual({ status: 'ok' });
    expect(svc.calls).toBe(1);
  });

  it('rethrows WebhookSignatureInvalidError so it surfaces as 400', async () => {
    svc.setNext(() => Promise.reject(new WebhookSignatureInvalidError('mock')));
    await expect(
      ctrl.webhook(
        'mock',
        { 'x-foo': 'bar' },
        makeReq({ provider_payment_id: 'p1', status: 'completed' }),
      ),
    ).rejects.toBeInstanceOf(WebhookSignatureInvalidError);
  });

  it('swallows non-signature processing errors and acks 200', async () => {
    svc.setNext(() => Promise.reject(new Error('db connection lost')));
    const res = await ctrl.webhook(
      'mock',
      { 'x-mock-signature': 'valid' },
      makeReq({ provider_payment_id: 'p1', status: 'completed' }),
    );
    expect(res).toEqual({ status: 'ok' });
  });

  it('returns 200 ack without calling service for unknown providers', async () => {
    const res = await ctrl.webhook('made_up_provider', {}, makeReq({}));
    expect(res).toEqual({ status: 'ok' });
    expect(svc.calls).toBe(0);
  });
});
