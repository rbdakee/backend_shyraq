import type { RawBodyRequest } from '@nestjs/common';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BccCallbackController } from './bcc-callback.controller';
import { PaymentService } from './payment.service';

class FakePayments {
  calls: unknown[] = [];
  processWebhook(input: unknown): Promise<unknown> {
    this.calls.push(input);
    return Promise.resolve({ paymentId: 'payment', status: 'completed' });
  }
}

describe('BccCallbackController', () => {
  const response = {
    type: jest.fn(),
  } as unknown as Response;

  it('passes the opaque token and urlencoded body to the settlement service', async () => {
    const payments = new FakePayments();
    const controller = new BccCallbackController(
      payments as unknown as PaymentService,
    );
    const body = { ORDER: '1234567' };
    await expect(
      controller.callback(
        'opaque-token',
        {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          authorization: 'Basic abc',
        },
        {
          body,
          rawBody: Buffer.from('ORDER=1234567'),
        } as unknown as RawBodyRequest<Request>,
        response,
      ),
    ).resolves.toBe('OK');
    expect(payments.calls).toEqual([
      expect.objectContaining({
        provider: 'bcc',
        callbackToken: 'opaque-token',
        body,
      }),
    ]);
  });

  it('rejects non-urlencoded callback bodies before settlement', async () => {
    const payments = new FakePayments();
    const controller = new BccCallbackController(
      payments as unknown as PaymentService,
    );
    await expect(
      controller.callback(
        'opaque-token',
        { 'content-type': 'application/json' },
        { body: {} } as RawBodyRequest<Request>,
        response,
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(payments.calls).toHaveLength(0);
  });
});
