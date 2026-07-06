import {
  BccMerchantAccount,
  BccMerchantAccountState,
} from './bcc-merchant-account.entity';

const CREATED_AT = new Date('2026-07-03T08:00:00.000Z');
const ACTOR_ID = '00000000-0000-4000-8000-000000000001';

function makeState(
  overrides: Partial<BccMerchantAccountState> = {},
): BccMerchantAccountState {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    kindergartenId: '00000000-0000-4000-8000-000000000020',
    merchantId: 'merchant-1',
    terminalId: '88888881',
    merchantName: 'Shyraq Test',
    macKeyEnc: 'encrypted-mac-key',
    environment: 'test',
    status: 'draft',
    callbackTokenHash: 'a'.repeat(64),
    callbackTokenEnc: 'encrypted-callback-token',
    notifyUsername: 'bcc-notify',
    notifyPasswordHash: '$2b$12$hash',
    lastConnectionCheckedAt: null,
    lastConnectionResult: null,
    disabledAt: null,
    updatedBy: ACTOR_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('BccMerchantAccount domain entity', () => {
  it('activates a draft account after a successful connection check', () => {
    const account = BccMerchantAccount.fromState(makeState());
    const checkedAt = new Date('2026-07-03T08:01:00.000Z');
    const activatedAt = new Date('2026-07-03T08:02:00.000Z');

    account.recordConnectionCheck(
      { success: true, action: '0', rc: '00', rcText: 'OK' },
      checkedAt,
      ACTOR_ID,
    );
    account.activate(activatedAt, ACTOR_ID);

    expect(account.status).toBe('active');
    expect(account.isActive()).toBe(true);
    expect(account.updatedAt).toEqual(activatedAt);
  });

  it('throws a stable domain error when no connection check exists', () => {
    const account = BccMerchantAccount.fromState(makeState());

    expect(() => account.activate(new Date(), ACTOR_ID)).toThrow(
      expect.objectContaining({
        code: 'bcc_merchant_account_activation_requires_connection_check',
      }),
    );
  });

  it('throws when the latest connection check failed', () => {
    const account = BccMerchantAccount.fromState(makeState());
    account.recordConnectionCheck(
      { success: false, action: '3', rc: '96', rcText: 'SYSTEM_ERROR' },
      new Date('2026-07-03T08:01:00.000Z'),
      ACTOR_ID,
    );

    expect(() => account.activate(new Date(), ACTOR_ID)).toThrow(
      expect.objectContaining({
        code: 'bcc_merchant_account_activation_requires_connection_check',
      }),
    );
  });

  it('requires a new successful check after disable before reactivation', () => {
    const checkedAt = new Date('2026-07-03T08:01:00.000Z');
    const account = BccMerchantAccount.fromState(
      makeState({
        status: 'active',
        lastConnectionCheckedAt: checkedAt,
        lastConnectionResult: {
          success: true,
          action: '0',
          rc: '00',
          rcText: 'OK',
        },
      }),
    );
    const disabledAt = new Date('2026-07-03T08:02:00.000Z');
    account.disable(disabledAt, ACTOR_ID);

    expect(() =>
      account.activate(new Date('2026-07-03T08:03:00.000Z'), ACTOR_ID),
    ).toThrow(
      expect.objectContaining({
        code: 'bcc_merchant_account_activation_requires_connection_check',
      }),
    );

    account.recordConnectionCheck(
      { success: true, action: '0', rc: '00', rcText: 'OK' },
      new Date('2026-07-03T08:04:00.000Z'),
      ACTOR_ID,
    );
    account.activate(new Date('2026-07-03T08:05:00.000Z'), ACTOR_ID);
    expect(account.status).toBe('active');
    expect(account.disabledAt).toBeNull();
  });

  it('rejects activating an already active account', () => {
    const account = BccMerchantAccount.fromState(
      makeState({
        status: 'active',
        lastConnectionCheckedAt: new Date('2026-07-03T08:01:00.000Z'),
        lastConnectionResult: {
          success: true,
          action: '0',
          rc: '00',
          rcText: 'OK',
        },
      }),
    );

    expect(() => account.activate(new Date(), ACTOR_ID)).toThrow(
      expect.objectContaining({
        code: 'bcc_merchant_account_status_invalid',
      }),
    );
  });

  it('disables idempotently and preserves the first disabled timestamp', () => {
    const account = BccMerchantAccount.fromState(
      makeState({ status: 'active' }),
    );
    const disabledAt = new Date('2026-07-03T08:02:00.000Z');

    account.disable(disabledAt, ACTOR_ID);
    account.disable(new Date('2026-07-03T08:03:00.000Z'), ACTOR_ID);

    expect(account.status).toBe('disabled');
    expect(account.disabledAt).toEqual(disabledAt);
  });

  it('does not expose a mutable connection result reference', () => {
    const result = { success: true, action: '0', rc: '00', rcText: 'OK' };
    const account = BccMerchantAccount.fromState(makeState());
    account.recordConnectionCheck(result, new Date(), ACTOR_ID);

    result.success = false;
    const returned = account.lastConnectionResult!;
    returned.success = false;

    expect(account.lastConnectionResult?.success).toBe(true);
  });
});
