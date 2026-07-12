import {
  constantTimeTextEqual,
  isBccSuccess,
  isBccTerminalFailure,
  parseBccBasicAuthorization,
  parseBccCallbackBody,
} from './bcc-callback';

describe('BCC callback protocol', () => {
  it('parses Basic Auth without accepting malformed credentials', () => {
    const value = `Basic ${Buffer.from('notify:secret').toString('base64')}`;
    expect(parseBccBasicAuthorization(value)).toEqual({
      username: 'notify',
      password: 'secret',
    });
    expect(parseBccBasicAuthorization('Bearer secret')).toBeNull();
    expect(parseBccBasicAuthorization('Basic !!!')).toBeNull();
    expect(parseBccBasicAuthorization(undefined)).toBeNull();
  });

  it('normalizes only the required safe callback result fields', () => {
    expect(
      parseBccCallbackBody({
        action: '0',
        rc: '00',
        rc_text: 'Approved',
        order: '1234567890123',
        amount: '350.00',
        currency: '398',
        terminal: '88888881',
        merchant: '00000001',
        rrn: '618721285042',
        int_ref: '6D1C6D9B343B89CA',
        P_SIGN: 'not-persisted',
        BILLING_ADDRESS: 'not-persisted',
      }),
    ).toEqual({
      action: '0',
      rc: '00',
      rcText: 'Approved',
      order: '1234567890123',
      amountKzt: 350,
      amount: '350.00',
      currency: '398',
      terminal: '88888881',
      merchant: '00000001',
      rrn: '618721285042',
      intRef: '6D1C6D9B343B89CA',
    });
  });

  it('rejects malformed money, nested fields and missing identity fields', () => {
    const valid = {
      ACTION: '0',
      RC: '00',
      ORDER: '1234567',
      AMOUNT: '350.00',
      CURRENCY: '398',
      TERMINAL: '88888881',
      MERCHANT: '00000001',
    };
    expect(() => parseBccCallbackBody({ ...valid, AMOUNT: '350' })).toThrow(
      'bcc_callback_amount_invalid',
    );
    expect(() =>
      parseBccCallbackBody({ ...valid, TERMINAL: ['88888881'] }),
    ).toThrow('bcc_callback_body_invalid');
    const { MERCHANT: _merchant, ...withoutMerchant } = valid;
    expect(() => parseBccCallbackBody(withoutMerchant)).toThrow(
      'bcc_callback_field_required:MERCHANT',
    );
  });

  it('maps only ACTION=0/RC=00 to success', () => {
    expect(isBccSuccess('0', '00')).toBe(true);
    expect(isBccSuccess('0', '51')).toBe(false);
    expect(isBccTerminalFailure('2', '51')).toBe(true);
    expect(isBccTerminalFailure('22', null)).toBe(false);
    expect(constantTimeTextEqual('merchant', 'merchant')).toBe(true);
    expect(constantTimeTextEqual('merchant', 'other')).toBe(false);
  });
});
