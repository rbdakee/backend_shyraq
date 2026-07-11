import type { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { PasswordHasherPort } from '@/modules/auth/password-hasher.port';
import { BccMerchantAccount } from '../../../domain/entities/bcc-merchant-account.entity';
import {
  BccCheckoutSession,
  BccCheckoutStorePort,
} from '../../checkout/bcc-checkout-store.port';
import { BccMerchantAccountRepository } from '../../persistence/bcc-merchant-account.repository';
import { BccPaymentProvider } from './bcc-payment-provider.adapter';
import {
  BccGatewayDiagnostics,
  BccGatewayResponse,
  BccHttpClient,
} from './bcc-http.client';

const KG = '00000000-0000-4000-8000-000000000001';
const PAYMENT = '00000000-0000-4000-8000-000000000002';
const MAC_KEY = '6BB0AC02E47BDF73D98FEB777F3B5294';
const TOKEN = 'A'.repeat(43);
const NOW = new Date('2026-07-06T08:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

class FakePasswords extends PasswordHasherPort {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hash:${plain}`);
  }
  compare(plain: string, hash: string): Promise<boolean> {
    return Promise.resolve(hash === `hash:${plain}`);
  }
}

class FakeCipher extends CryptoCipherPort {
  encrypt(value: Buffer): string {
    return `enc:${value.toString('utf8')}`;
  }
  decrypt(value: string): Buffer {
    return Buffer.from(value.replace(/^enc:/, ''), 'utf8');
  }
  encryptString(value: string): string {
    return `enc:${value}`;
  }
  decryptString(value: string): string {
    return value.replace(/^enc:/, '');
  }
}

class CheckoutStore extends BccCheckoutStorePort {
  session: BccCheckoutSession | null = null;
  token: string | null = TOKEN;

  createOrReuse(session: BccCheckoutSession) {
    this.session = session;
    return Promise.resolve({ token: TOKEN, expiresInSeconds: 900 });
  }
  findTokenByPayment() {
    return Promise.resolve(this.token);
  }
  consume() {
    return Promise.resolve(null);
  }
}

function gatewayResponse(
  diagnostics: Partial<BccGatewayDiagnostics>,
  httpStatus = 200,
): BccGatewayResponse {
  return {
    httpStatus,
    httpOk: httpStatus >= 200 && httpStatus < 300,
    fields: {},
    diagnostics: {
      action: null,
      rc: null,
      rcText: null,
      order: null,
      rrn: null,
      intRef: null,
      ...diagnostics,
    },
  };
}

class FakeHttp {
  calls = 0;
  environment: 'test' | 'live' | null = null;
  request: Record<string, string> | null = null;

  constructor(
    private readonly result:
      | { ok: true; response: BccGatewayResponse }
      | { ok: false; error: Error },
  ) {}

  execute(
    environment: 'test' | 'live',
    fields: Record<string, string>,
  ): Promise<BccGatewayResponse> {
    this.calls += 1;
    this.environment = environment;
    this.request = { ...fields };
    return this.result.ok
      ? Promise.resolve(this.result.response)
      : Promise.reject(this.result.error);
  }
}

function baseRefundInput() {
  return {
    kindergartenId: KG,
    providerPaymentId: '1234567890123',
    amountKzt: 100,
    reason: 'parent request',
    idempotencyKey: 'refund:00000000-0000-4000-8000-000000000004',
    originalAmountKzt: 350 as number | undefined,
    originalProviderData: {
      rrn: '618721285042',
      int_ref: '6D1C6D9B343B89CA',
    } as Record<string, unknown> | null,
  };
}

function account(status: 'active' | 'disabled' = 'active'): BccMerchantAccount {
  return BccMerchantAccount.fromState({
    id: '00000000-0000-4000-8000-000000000010',
    kindergartenId: KG,
    merchantId: '00000001',
    terminalId: '88888881',
    merchantName: 'SHYRAQ TEST',
    macKeyEnc: `enc:${MAC_KEY}`,
    environment: 'test',
    status,
    callbackTokenHash: 'a'.repeat(64),
    callbackTokenEnc: 'enc:callback-token',
    notifyUsername: 'notify',
    notifyPasswordHash: 'hash:secret',
    lastConnectionCheckedAt: NOW,
    lastConnectionResult: {
      success: true,
      action: '0',
      rc: '00',
      rcText: 'OK',
    },
    disabledAt: null,
    updatedBy: '00000000-0000-4000-8000-000000000011',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function config(): ConfigService<AllConfigType> {
  return {
    getOrThrow: (key: string) => {
      if (key === 'app.backendDomain') return 'https://api.example.test';
      if (key === 'app.apiPrefix') return 'api';
      throw new Error(`unexpected config key: ${key}`);
    },
  } as unknown as ConfigService<AllConfigType>;
}

function provider(
  merchantAccount: BccMerchantAccount = account(),
  store = new CheckoutStore(),
  http: FakeHttp | Record<string, never> = {},
) {
  return {
    store,
    http,
    provider: new BccPaymentProvider(
      {
        findByKindergartenId: () => Promise.resolve(merchantAccount),
        findByCallbackTokenHashBypassRls: () =>
          Promise.resolve(merchantAccount),
      } as unknown as BccMerchantAccountRepository,
      store,
      new FakeCipher(),
      new FixedClock(),
      config(),
      new FakePasswords(),
      http as unknown as BccHttpClient,
    ),
  };
}

describe('BccPaymentProvider', () => {
  it('prepares only the CARD step #1 and returns the Shyraq bridge URL', async () => {
    const h = provider();
    const result = await h.provider.createPayment({
      paymentId: PAYMENT,
      kindergartenId: KG,
      invoiceId: '00000000-0000-4000-8000-000000000003',
      amountKzt: 350,
      currency: 'KZT',
      returnUrl: '',
      billingPhone: '+77011234567',
      billingAddress: 'Алматы, Абая 1',
      idempotencyKey: '00000000-0000-4000-8000-000000000004',
    });

    expect(result.status).toBe('initiated');
    expect(result.providerPaymentId).toMatch(/^\d{32}$/);
    expect(result.redirectUrl).toBe(
      `https://api.example.test:443/api/v1/payments/bcc/checkout/${TOKEN}`,
    );
    expect(h.store.session).toMatchObject({
      paymentId: PAYMENT,
      kindergartenId: KG,
      order: result.providerPaymentId,
      gatewayUrl: 'https://test3ds.bcc.kz:5445/cgi-bin/cgi_link',
      billingPhone: '+77011234567',
      billingAddress: 'Алматы, Абая 1',
      formFields: {
        TRTYPE: '1',
        MERCHANT: '00000001',
        TERMINAL: '88888881',
        BACKREF: 'https://api.example.test:443/api/v1/payments/bcc/return',
        NOTIFY_URL:
          'https://api.example.test:443/api/v1/webhooks/payments/bcc/callback-token',
      },
    });
    expect(h.store.session?.formFields.P_SIGN).toMatch(/^[0-9A-F]{40}$/);
    expect(h.store.session?.formFields).not.toHaveProperty('CLIENT_IP');
    expect(h.store.session?.formFields).not.toHaveProperty('M_INFO');
    expect(h.store.session?.formFields).not.toHaveProperty('CARD');
    expect(h.store.session?.formFields).not.toHaveProperty('CVC2');
    expect(result.providerPayload).not.toHaveProperty('billing_phone');
    expect(result.providerPayload).not.toHaveProperty('billing_address');
  });

  it('returns the same live checkout URL for an idempotent retry', async () => {
    const h = provider();

    await expect(
      h.provider.getExistingPaymentContinuation({
        kindergartenId: KG,
        paymentId: PAYMENT,
      }),
    ).resolves.toEqual({
      redirectUrl: `https://api.example.test:443/api/v1/payments/bcc/checkout/${TOKEN}`,
    });
  });

  it('rejects a retry after the checkout session was consumed', async () => {
    const h = provider();
    h.store.token = null;

    await expect(
      h.provider.getExistingPaymentContinuation({
        kindergartenId: KG,
        paymentId: PAYMENT,
      }),
    ).rejects.toMatchObject({ code: 'bcc_checkout_expired' });
  });

  it('rejects initiation without both billing fields or an active account', async () => {
    const h = provider();
    await expect(
      h.provider.createPayment({
        paymentId: PAYMENT,
        kindergartenId: KG,
        invoiceId: '00000000-0000-4000-8000-000000000003',
        amountKzt: 350,
        currency: 'KZT',
        returnUrl: '',
        idempotencyKey: '00000000-0000-4000-8000-000000000004',
      }),
    ).rejects.toMatchObject({ code: 'bcc_billing_details_required' });

    const disabled = provider(account('disabled')).provider;
    await expect(
      disabled.createPayment({
        paymentId: PAYMENT,
        kindergartenId: KG,
        invoiceId: '00000000-0000-4000-8000-000000000003',
        amountKzt: 350,
        currency: 'KZT',
        returnUrl: '',
        billingPhone: '+77011234567',
        billingAddress: 'Алматы',
        idempotencyKey: '00000000-0000-4000-8000-000000000004',
      }),
    ).rejects.toMatchObject({ code: 'bcc_not_connected' });
  });

  it('authenticates and sanitizes a successful BCC callback', async () => {
    const h = provider();
    const result = await h.provider.verifyWebhook({
      callbackToken: 'callback-token',
      headers: {
        authorization: `Basic ${Buffer.from('notify:secret').toString('base64')}`,
      },
      body: {
        ACTION: '0',
        RC: '00',
        RC_TEXT: 'Approved',
        ORDER: '1234567890123',
        AMOUNT: '350.00',
        CURRENCY: '398',
        TERMINAL: '88888881',
        MERCHANT: '00000001',
        RRN: '618721285042',
        INT_REF: '6D1C6D9B343B89CA',
        P_SIGN: 'must-not-be-persisted',
      },
    });

    expect(result).toEqual({
      providerPaymentId: '1234567890123',
      status: 'completed',
      raw: {
        action: '0',
        rc: '00',
        rc_text: 'Approved',
        rrn: '618721285042',
        int_ref: '6D1C6D9B343B89CA',
        source: 'bcc_callback',
      },
      callbackContext: {
        kindergartenId: KG,
        amountKzt: 350,
        currency: '398',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-persisted');
  });

  it('rejects invalid Basic Auth and merchant identity', async () => {
    const h = provider();
    const input = {
      callbackToken: 'callback-token',
      headers: {
        authorization: `Basic ${Buffer.from('notify:wrong').toString('base64')}`,
      },
      body: {
        ACTION: '0',
        RC: '00',
        ORDER: '1234567890123',
        AMOUNT: '350.00',
        CURRENCY: '398',
        TERMINAL: '88888881',
        MERCHANT: '00000001',
      },
    };
    await expect(h.provider.verifyWebhook(input)).rejects.toMatchObject({
      code: 'bcc_callback_unauthorized',
    });
    await expect(
      h.provider.verifyWebhook({
        ...input,
        headers: {
          authorization: `Basic ${Buffer.from('notify:secret').toString('base64')}`,
        },
        body: { ...input.body, MERCHANT: 'another-tenant' },
      }),
    ).rejects.toMatchObject({ code: 'bcc_callback_invalid' });
  });

  it('signs a partial TRTYPE=14 refund and returns the BCC refund identifier', async () => {
    const http = new FakeHttp({
      ok: true,
      response: gatewayResponse({ action: '0', rc: '00', rrn: '618729999999' }),
    });
    const h = provider(account(), new CheckoutStore(), http);

    const result = await h.provider.refund(baseRefundInput());

    expect(result).toEqual({
      providerRefundId: '618729999999',
      status: 'processed',
    });
    expect(http.calls).toBe(1);
    expect(http.environment).toBe('test');
    expect(http.request).toMatchObject({
      TRTYPE: '14',
      ORDER: '1234567890123',
      ORG_AMOUNT: '350.00',
      AMOUNT: '100.00',
      CURRENCY: '398',
      RRN: '618721285042',
      INT_REF: '6D1C6D9B343B89CA',
      TERMINAL: '88888881',
    });
    expect(http.request?.P_SIGN).toMatch(/^[0-9A-F]{40}$/);
    // MAC key material and card data never travel in the request.
    expect(JSON.stringify(http.request)).not.toContain(MAC_KEY);
    expect(http.request).not.toHaveProperty('CARD');
  });

  it('sends the full original amount for a full refund', async () => {
    const http = new FakeHttp({
      ok: true,
      response: gatewayResponse({ action: '0', rc: '00', rrn: '618720000001' }),
    });
    const h = provider(account(), new CheckoutStore(), http);

    await h.provider.refund({ ...baseRefundInput(), amountKzt: 350 });

    expect(http.request).toMatchObject({
      ORG_AMOUNT: '350.00',
      AMOUNT: '350.00',
    });
  });

  it('falls back to a deterministic refund id when BCC omits RRN/INT_REF', async () => {
    const http = new FakeHttp({
      ok: true,
      response: gatewayResponse({ action: '0', rc: '00' }),
    });
    const h = provider(account(), new CheckoutStore(), http);

    const result = await h.provider.refund(baseRefundInput());

    expect(result.providerRefundId).toBe('bcc_refund_1234567890123');
  });

  it('throws on a declined refund so the local refund stays retryable', async () => {
    const http = new FakeHttp({
      ok: true,
      response: gatewayResponse({ action: '2', rc: '51' }),
    });
    const h = provider(account(), new CheckoutStore(), http);

    await expect(h.provider.refund(baseRefundInput())).rejects.toThrow(
      'bcc_refund_declined:RC=51',
    );
    expect(http.calls).toBe(1);
  });

  it('refuses to sign a refund without the original RRN/INT_REF/amount', async () => {
    const http = new FakeHttp({
      ok: true,
      response: gatewayResponse({ action: '0', rc: '00' }),
    });
    const h = provider(account(), new CheckoutStore(), http);

    await expect(
      h.provider.refund({
        ...baseRefundInput(),
        originalProviderData: { rrn: '618721285042' },
      }),
    ).rejects.toThrow('bcc_refund_context_missing');
    await expect(
      h.provider.refund({ ...baseRefundInput(), originalAmountKzt: undefined }),
    ).rejects.toThrow('bcc_refund_context_missing');
    expect(http.calls).toBe(0);
  });

  it('propagates a transport failure without marking the refund processed', async () => {
    const http = new FakeHttp({
      ok: false,
      error: new Error('bcc_http_failed:TRTYPE=14'),
    });
    const h = provider(account(), new CheckoutStore(), http);

    await expect(h.provider.refund(baseRefundInput())).rejects.toThrow(
      'bcc_http_failed:TRTYPE=14',
    );
  });
});
