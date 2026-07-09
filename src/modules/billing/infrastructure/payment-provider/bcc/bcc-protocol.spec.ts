import {
  BCC_LIVE_GATEWAY_URL,
  BCC_TEST_GATEWAY_URL,
  bccGatewayUrl,
  buildBccPurchaseRequest,
  buildBccRefundRequest,
  buildBccStatusRequest,
} from './bcc-protocol';

const MAC_KEY_HEX = '6BB0AC02E47BDF73D98FEB777F3B5294';
const COMMON = {
  order: '3558714461568',
  terminalId: '88888881',
  timestamp: '20200224073921',
  nonce: 'F2B2DD7E603A7AAF5E1BC35DEE1F6C9A',
  macKeyHex: MAC_KEY_HEX,
};

describe('BCC protocol request builders', () => {
  it('builds a signed TRTYPE=1 browser form without deferred token fields', () => {
    const fields = buildBccPurchaseRequest({
      ...COMMON,
      amount: '350.00',
      merchRnId: 'ABCDEF0123456789',
      description: 'Оплата счёта',
      merchantId: 'merchantname',
      merchantName: 'Shyraq Test',
      backref:
        'https://balam-api-dev.innodev.kz:443/api/v1/payments/bcc/return',
      language: 'ru',
      notifyUrl:
        'https://balam-api-dev.innodev.kz:443/api/v1/webhooks/payments/bcc/token',
      clientIp: '203.0.113.10',
      mInfo: 'eyJicm93c2VyU2NyZWVuSGVpZ2h0IjoxfQ==',
    });

    expect(fields).toMatchObject({
      AMOUNT: '350.00',
      CURRENCY: '398',
      ORDER: COMMON.order,
      MERCHANT: 'merchantname',
      MERCH_NAME: 'Shyraq Test',
      TERMINAL: COMMON.terminalId,
      MERCH_GMT: '0',
      TIMESTAMP: COMMON.timestamp,
      TRTYPE: '1',
      NONCE: COMMON.nonce,
      MERCH_RN_ID: 'ABCDEF0123456789',
      DESC: 'Оплата счёта',
      P_SIGN: '9B1C58714CFF6E4BCC6E97B4D503275838F4ED68',
    });
    expect(fields).not.toHaveProperty('MK_TOKEN');
    expect(fields).not.toHaveProperty('RQ_AUTH');
  });

  it('builds a signed TRTYPE=14 refund request', () => {
    const fields = buildBccRefundRequest({
      ...COMMON,
      originalAmount: '350.00',
      amount: '350.00',
      rrn: '821185120045',
      intRef: '9C2176F638FDC05C',
      notifyUrl: 'https://example.test/bcc/callback',
    });

    expect(fields).toEqual({
      ORDER: COMMON.order,
      ORG_AMOUNT: '350.00',
      AMOUNT: '350.00',
      CURRENCY: '398',
      RRN: '821185120045',
      INT_REF: '9C2176F638FDC05C',
      TERMINAL: COMMON.terminalId,
      TIMESTAMP: COMMON.timestamp,
      TRTYPE: '14',
      NONCE: COMMON.nonce,
      P_SIGN: '0D8ABFC1215135BD51AB27C10E2CD621C5AF1432',
      NOTIFY_URL: 'https://example.test/bcc/callback',
    });
  });

  it('builds a signed TRTYPE=90 status request', () => {
    const fields = buildBccStatusRequest({
      ...COMMON,
      notifyUrl: 'https://example.test/bcc/callback',
    });

    expect(fields).toEqual({
      ORDER: COMMON.order,
      TERMINAL: COMMON.terminalId,
      TIMESTAMP: COMMON.timestamp,
      TRTYPE: '90',
      NONCE: COMMON.nonce,
      TRAN_TRTYPE: '1',
      MERCH_GMT: '0',
      NOTIFY_URL: 'https://example.test/bcc/callback',
      P_SIGN: '7C0D8BF3F6C7DCB0AA35E88F045292E176184B5E',
    });
  });

  it('maps account environments to the fixed BCC gateway URLs', () => {
    expect(bccGatewayUrl('test')).toBe(BCC_TEST_GATEWAY_URL);
    expect(bccGatewayUrl('live')).toBe(BCC_LIVE_GATEWAY_URL);
  });

  it('rejects malformed protocol identifiers before signing', () => {
    const base = {
      ...COMMON,
      originalAmount: '350.00',
      amount: '350.00',
      rrn: '821185120045',
      intRef: '9C2176F638FDC05C',
    };

    expect(() => buildBccRefundRequest({ ...base, order: 'abc' })).toThrow(
      'bcc_request_order_invalid',
    );
    expect(() =>
      buildBccRefundRequest({ ...base, timestamp: '2026-07-03' }),
    ).toThrow('bcc_request_timestamp_invalid');
    expect(() => buildBccRefundRequest({ ...base, nonce: 'not-hex' })).toThrow(
      'bcc_request_nonce_invalid',
    );
    expect(() => buildBccRefundRequest({ ...base, currency: 'KZT' })).toThrow(
      'bcc_request_currency_invalid',
    );
  });
});
