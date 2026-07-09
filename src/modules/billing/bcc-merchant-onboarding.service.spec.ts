import { ConfigService } from '@nestjs/config';
import { PasswordHasherPort } from '@/modules/auth/password-hasher.port';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { BccMerchantAccount } from './domain/entities/bcc-merchant-account.entity';
import { BccMerchantAccountRepository } from './infrastructure/persistence/bcc-merchant-account.repository';
import {
  BccGatewayResponse,
  BccHttpClient,
} from './infrastructure/payment-provider/bcc/bcc-http.client';
import { BccFormFields } from './infrastructure/payment-provider/bcc/bcc-protocol';
import { BccMerchantOnboardingService } from './bcc-merchant-onboarding.service';

const KG_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const COMPONENT_1 = '690B5589573ACB3608DB7395A319B175';
const COMPONENT_2 = '02BBF98BB3411445D15498E2DC22E3E1';
const MAC_KEY = '6BB0AC02E47BDF73D98FEB777F3B5294';

class FakeAccounts extends BccMerchantAccountRepository {
  readonly values = new Map<string, BccMerchantAccount>();
  bypassSaves = 0;

  findById(
    kindergartenId: string,
    id: string,
  ): Promise<BccMerchantAccount | null> {
    const account = this.values.get(kindergartenId);
    return Promise.resolve(account?.id === id ? account : null);
  }

  findByKindergartenId(
    kindergartenId: string,
  ): Promise<BccMerchantAccount | null> {
    return Promise.resolve(this.values.get(kindergartenId) ?? null);
  }

  findByCallbackTokenHashBypassRls(
    callbackTokenHash: string,
  ): Promise<BccMerchantAccount | null> {
    return Promise.resolve(
      [...this.values.values()].find(
        (account) => account.callbackTokenHash === callbackTokenHash,
      ) ?? null,
    );
  }

  save(account: BccMerchantAccount): Promise<BccMerchantAccount> {
    this.values.set(account.kindergartenId, account);
    return Promise.resolve(account);
  }

  saveBypassRls(account: BccMerchantAccount): Promise<BccMerchantAccount> {
    this.bypassSaves += 1;
    return this.save(account);
  }
}

class FakeCipher extends CryptoCipherPort {
  encrypt(plaintext: Buffer): string {
    return `enc:${plaintext.toString('base64')}`;
  }

  decrypt(blobBase64: string): Buffer {
    return Buffer.from(blobBase64.slice(4), 'base64');
  }

  encryptString(plaintext: string): string {
    return this.encrypt(Buffer.from(plaintext, 'utf8'));
  }

  decryptString(blobBase64: string): string {
    return this.decrypt(blobBase64).toString('utf8');
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

class FakeClock extends ClockPort {
  current = new Date('2026-07-06T04:30:00.000Z');

  now(): Date {
    return new Date(this.current);
  }
}

class FakeHttp extends BccHttpClient {
  response: BccGatewayResponse = {
    httpStatus: 200,
    httpOk: true,
    fields: { ACTION: '0', RC: '00' },
    diagnostics: {
      action: '0',
      rc: '00',
      rcText: 'APPROVED',
      order: null,
      rrn: null,
      intRef: null,
    },
  };
  error: Error | null = null;
  lastFields: Readonly<BccFormFields> | null = null;

  override execute(
    _environment: 'test' | 'live',
    fields: Readonly<BccFormFields>,
  ): Promise<BccGatewayResponse> {
    this.lastFields = fields;
    return this.error
      ? Promise.reject(this.error)
      : Promise.resolve(this.response);
  }
}

describe('BccMerchantOnboardingService', () => {
  let accounts: FakeAccounts;
  let cipher: FakeCipher;
  let http: FakeHttp;
  let clock: FakeClock;
  let service: BccMerchantOnboardingService;

  beforeEach(() => {
    accounts = new FakeAccounts();
    cipher = new FakeCipher();
    http = new FakeHttp();
    clock = new FakeClock();
    const kindergartens = {
      findById: (id: string) =>
        Promise.resolve(id === KG_ID ? { id: KG_ID } : null),
    } as unknown as KindergartenRepository;
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'app.backendDomain') return 'https://api.example.test:443';
        if (key === 'app.apiPrefix') return 'api';
        throw new Error(`unexpected config key ${key}`);
      },
    } as ConfigService<AllConfigType>;
    service = new BccMerchantOnboardingService(
      accounts,
      kindergartens,
      cipher,
      new FakePasswords(),
      http,
      clock,
      config,
    );
  });

  it('creates a draft account and returns callback credentials only once', async () => {
    const created = await provision(service);

    expect(created.account.status).toBe('draft');
    expect(created.callbackCredentials).toEqual({
      notifyUrl: expect.stringMatching(
        /^https:\/\/api\.example\.test\/api\/v1\/webhooks\/payments\/bcc\//,
      ),
      notifyUsername: expect.stringMatching(/^bcc_[0-9a-f]{24}$/),
      notifyPassword: expect.any(String),
    });

    const persisted = accounts.values.get(KG_ID)!.toState();
    expect(cipher.decryptString(persisted.macKeyEnc)).toBe(MAC_KEY);
    expect(persisted).not.toHaveProperty('macKeyComponent1');
    expect(persisted).not.toHaveProperty('macKeyComponent2');
    expect(persisted.notifyPasswordHash).toMatch(/^hash:/);
    expect(persisted.callbackTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cipher.decryptString(persisted.callbackTokenEnc)).not.toBe('');

    const fetched = await service.get(KG_ID);
    expect(fetched).not.toHaveProperty('macKeyEnc');
    expect(fetched).not.toHaveProperty('callbackTokenHash');
    expect(fetched).not.toHaveProperty('notifyPasswordHash');

    const updated = await provision(service);
    expect(updated.callbackCredentials).toBeUndefined();
  });

  it('activates only after a successful TRTYPE=800 check', async () => {
    await provision(service);
    const checked = await service.checkConnection(KG_ID, ACTOR_ID);

    expect(checked.connected).toBe(true);
    expect(checked.status).toBe('active');
    expect(http.lastFields).toEqual(
      expect.objectContaining({
        TERMINAL: '88888881',
        TRTYPE: '800',
        BACKREF: 'https://api.example.test/api/v1/payments/bcc/return',
        LANG: 'ru',
        NOTIFY_URL: expect.stringMatching(
          /^https:\/\/api\.example\.test\/api\/v1\/webhooks\/payments\/bcc\//,
        ),
      }),
    );
    expect(http.lastFields).not.toHaveProperty('P_SIGN');
  });

  it('persists sanitized diagnostics outside the failed request transaction', async () => {
    await provision(service);
    http.response = {
      httpStatus: 200,
      httpOk: true,
      fields: {},
      diagnostics: {
        action: '3\r\n',
        rc: '96',
        rcText: 'DECLINED\r\nunsafe',
        order: null,
        rrn: null,
        intRef: null,
      },
    };

    await expect(
      service.checkConnection(KG_ID, ACTOR_ID),
    ).rejects.toMatchObject({ code: 'bcc_connection_check_failed' });
    expect(accounts.bypassSaves).toBe(1);
    expect(accounts.values.get(KG_ID)?.lastConnectionResult).toEqual({
      success: false,
      action: '3',
      rc: '96',
      rcText: 'DECLINED  unsafe',
    });
  });

  it('records a transport failure and returns a stable gateway error', async () => {
    await provision(service);
    http.error = new Error('secret-bearing transport message');

    await expect(
      service.checkConnection(KG_ID, ACTOR_ID),
    ).rejects.toMatchObject({ code: 'bcc_gateway_unavailable' });
    expect(accounts.bypassSaves).toBe(1);
    expect(accounts.values.get(KG_ID)?.lastConnectionResult?.rcText).toBe(
      'transport_error',
    );
  });

  it('disables independently and MAC rotation returns the account to draft', async () => {
    await provision(service);
    await service.checkConnection(KG_ID, ACTOR_ID);
    await service.disable(KG_ID, ACTOR_ID);

    expect((await service.get(KG_ID)).status).toBe('disabled');
    const rotated = await service.rotateMac(
      KG_ID,
      COMPONENT_1,
      COMPONENT_2,
      ACTOR_ID,
    );
    expect(rotated.status).toBe('draft');
    expect(rotated.lastConnectionResult).toBeNull();
  });

  it('rotates callback credentials and invalidates the previous token hash', async () => {
    const created = await provision(service);
    const before = accounts.values.get(KG_ID)!.callbackTokenHash;

    const rotated = await service.rotateCallbackCredentials(KG_ID, ACTOR_ID);

    expect(rotated.notifyUrl).not.toBe(created.callbackCredentials?.notifyUrl);
    expect(accounts.values.get(KG_ID)!.callbackTokenHash).not.toBe(before);
    expect(rotated.notifyPassword).not.toBe('');
  });

  it('rejects a normal upsert while the account is active', async () => {
    await provision(service);
    await service.checkConnection(KG_ID, ACTOR_ID);

    await expect(provision(service)).rejects.toMatchObject({
      code: 'bcc_account_active',
    });
  });
});

function provision(service: BccMerchantOnboardingService) {
  return service.upsert(
    KG_ID,
    {
      merchantId: 'SHYRAQ_TEST_MERCHANT',
      terminalId: '88888881',
      merchantName: 'Shyraq Test',
      environment: 'test',
      macKeyComponent1: COMPONENT_1,
      macKeyComponent2: COMPONENT_2,
    },
    ACTOR_ID,
  );
}
