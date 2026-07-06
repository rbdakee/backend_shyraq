import {
  BccMacFields,
  buildBccConnectivityCheckRequest,
  buildBccMacSource,
  combineBccMacKeyComponents,
  computeBccPSign,
  formatBccAmount,
  formatBccTimestamp,
  generateBccMerchRnId,
  generateBccNonce,
  generateBccOrder,
} from './bcc-crypto';

const MAC_KEY_HEX = '6BB0AC02E47BDF73D98FEB777F3B5294';

const COMMON = {
  ORDER: '3558714461568',
  TERMINAL: '88888881',
  TIMESTAMP: '20200224073921',
  NONCE: 'F2B2DD7E603A7AAF5E1BC35DEE1F6C9A',
} satisfies BccMacFields;

const VECTORS: Array<{
  trType: '1' | '14' | '90';
  fields: BccMacFields;
  source: string;
  pSign: string;
}> = [
  {
    trType: '1',
    fields: {
      ...COMMON,
      AMOUNT: '350.00',
      CURRENCY: '398',
      MERCHANT: 'merchantname',
      MERCH_GMT: '0',
      TRTYPE: '1',
    },
    source:
      '6350.00339813355871446156812merchantname8888888811014202002240739211132F2B2DD7E603A7AAF5E1BC35DEE1F6C9A',
    pSign: '9B1C58714CFF6E4BCC6E97B4D503275838F4ED68',
  },
  {
    trType: '14',
    fields: {
      ...COMMON,
      ORG_AMOUNT: '350.00',
      AMOUNT: '350.00',
      CURRENCY: '398',
      RRN: '821185120045',
      INT_REF: '9C2176F638FDC05C',
      TRTYPE: '14',
    },
    source:
      '1335587144615686350.006350.00339812821185120045169C2176F638FDC05C888888881142020022407392121432F2B2DD7E603A7AAF5E1BC35DEE1F6C9A',
    pSign: '0D8ABFC1215135BD51AB27C10E2CD621C5AF1432',
  },
  {
    trType: '90',
    fields: {
      ...COMMON,
      TRTYPE: '90',
    },
    source:
      '133558714461568888888881142020022407392129032F2B2DD7E603A7AAF5E1BC35DEE1F6C9A',
    pSign: '7C0D8BF3F6C7DCB0AA35E88F045292E176184B5E',
  },
];

describe('bcc-crypto', () => {
  it.each(VECTORS)(
    'reproduces the published TRTYPE=$trType source and P_SIGN',
    ({ trType, fields, source, pSign }) => {
      expect(buildBccMacSource(trType, fields)).toBe(source);
      expect(computeBccPSign(trType, fields, MAC_KEY_HEX)).toBe(pSign);
    },
  );

  it('rejects an unsupported or mismatched TRTYPE', () => {
    expect(() => buildBccMacSource('22', {})).toThrow(
      'bcc_mac_trtype_unsupported:22',
    );
    expect(() => buildBccMacSource('90', { ...COMMON, TRTYPE: '1' })).toThrow(
      'bcc_mac_trtype_mismatch',
    );
  });

  it('rejects missing fields, Unicode ambiguity, and malformed HEX keys', () => {
    expect(() =>
      buildBccMacSource('90', { ...COMMON, TRTYPE: '90', ORDER: '' }),
    ).toThrow('bcc_mac_field_required:ORDER');
    expect(() =>
      buildBccMacSource('90', {
        ...COMMON,
        TRTYPE: '90',
        ORDER: 'заказ123',
      }),
    ).toThrow('bcc_mac_field_non_ascii:ORDER');
    expect(() =>
      computeBccPSign('90', { ...COMMON, TRTYPE: '90' }, 'not-hex'),
    ).toThrow('bcc_mac_key_invalid');
  });

  it('formats money independently of locale and timestamps in UTC', () => {
    expect(formatBccAmount('350')).toBe('350.00');
    expect(formatBccAmount('350.5')).toBe('350.50');
    expect(formatBccTimestamp(new Date('2020-02-24T07:39:21+05:00'))).toBe(
      '20200224023921',
    );
  });

  it('XORs the two published MAC key components', () => {
    const combined = combineBccMacKeyComponents(
      '690B5589573ACB3608DB7395A319B175',
      '02BBF98BB3411445D15498E2DC22E3E1',
    );
    expect(combined.toString('hex').toUpperCase()).toBe(MAC_KEY_HEX);
    expect(() => combineBccMacKeyComponents('00', '11')).toThrow(
      'bcc_mac_components_invalid',
    );
  });

  it('generates unique protocol identifiers in the documented formats', () => {
    const nonces = new Set(
      Array.from({ length: 128 }, () => generateBccNonce()),
    );
    const orders = new Set(
      Array.from({ length: 128 }, () =>
        generateBccOrder(new Date('2026-07-03T00:00:00Z')),
      ),
    );
    expect(nonces.size).toBe(128);
    expect(orders.size).toBe(128);
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9A-F]{32}$/);
    for (const order of orders) expect(order).toMatch(/^\d{32}$/);
    expect(generateBccMerchRnId()).toMatch(/^[0-9A-F]{16}$/);
  });

  it('builds TRTYPE=800 without P_SIGN', () => {
    const request = buildBccConnectivityCheckRequest({
      terminal: '88888881',
      backref:
        'https://balam-api-dev.innodev.kz:443/api/v1/payments/bcc/return',
      lang: 'ru',
      notifyUrl:
        'https://balam-api-dev.innodev.kz:443/api/v1/webhooks/payments/bcc/token',
    });
    expect(request).toEqual({
      TERMINAL: '88888881',
      TRTYPE: '800',
      BACKREF:
        'https://balam-api-dev.innodev.kz:443/api/v1/payments/bcc/return',
      LANG: 'ru',
      NOTIFY_URL:
        'https://balam-api-dev.innodev.kz:443/api/v1/webhooks/payments/bcc/token',
    });
    expect(request).not.toHaveProperty('P_SIGN');
  });
});
