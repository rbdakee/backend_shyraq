import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  BccMerchantAccount,
  BccMerchantAccountState,
} from './domain/entities/bcc-merchant-account.entity';
import { UserPaymentProfile } from './domain/entities/user-payment-profile.entity';
import { BccMerchantAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/bcc-merchant-account.typeorm.entity';
import { UserPaymentProfileTypeOrmEntity } from './infrastructure/persistence/relational/entities/user-payment-profile.typeorm.entity';
import { BccMerchantAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/bcc-merchant-account.relational.repository';
import { UserPaymentProfileRelationalRepository } from './infrastructure/persistence/relational/repositories/user-payment-profile.relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('BCC Gate B persistence and RLS', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let accountRepository: BccMerchantAccountRelationalRepository;
  let profileRepository: UserPaymentProfileRelationalRepository;
  let kgA: string;
  let kgB: string;
  let saasUserId: string;
  let payerUserId: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: process.env.DATABASE_PORT
        ? parseInt(process.env.DATABASE_PORT, 10)
        : 5432,
      username: process.env.DATABASE_USERNAME ?? 'shyraq_app',
      password: process.env.DATABASE_PASSWORD ?? 'shyraq_app',
      database: process.env.DATABASE_NAME ?? 'shyraq',
      entities: [
        BccMerchantAccountTypeOrmEntity,
        UserPaymentProfileTypeOrmEntity,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    accountRepository = new BccMerchantAccountRelationalRepository(
      dataSource,
      dataSource.getRepository(BccMerchantAccountTypeOrmEntity),
    );
    profileRepository = new UserPaymentProfileRelationalRepository(
      dataSource.getRepository(UserPaymentProfileTypeOrmEntity),
    );

    kgA = randomUUID();
    kgB = randomUUID();
    saasUserId = randomUUID();
    payerUserId = randomUUID();

    await withBypass(async (manager) => {
      await manager.query(
        `INSERT INTO kindergartens (id, name, slug)
         VALUES ($1, 'BCC Gate B KG-A', $2), ($3, 'BCC Gate B KG-B', $4)`,
        [
          kgA,
          `bcc-gate-b-a-${kgA.slice(0, 8)}`,
          kgB,
          `bcc-gate-b-b-${kgB.slice(0, 8)}`,
        ],
      );
      await manager.query(
        `INSERT INTO saas_users
           (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'BCC Gate B Operator', 'not-a-real-hash', 'super_admin', true)`,
        [saasUserId, `bcc-gate-b-${saasUserId.slice(0, 8)}@example.test`],
      );
      await manager.query(
        `INSERT INTO users (id, phone, full_name)
         VALUES ($1, $2, 'BCC Gate B Payer')`,
        [payerUserId, `+7700${payerUserId.replace(/-/g, '').slice(0, 7)}`],
      );
    });
  });

  beforeEach(async () => {
    await withBypass(async (manager) => {
      await manager.query(
        `DELETE FROM bcc_merchant_accounts
          WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await manager.query(
        `DELETE FROM user_payment_profiles WHERE user_id = $1`,
        [payerUserId],
      );
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await withBypass(async (manager) => {
      await manager.query(
        `DELETE FROM bcc_merchant_accounts
          WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await manager.query(
        `DELETE FROM user_payment_profiles WHERE user_id = $1`,
        [payerUserId],
      );
      await manager.query(`DELETE FROM users WHERE id = $1`, [payerUserId]);
      await manager.query(`DELETE FROM saas_users WHERE id = $1`, [saasUserId]);
      await manager.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
        kgA,
        kgB,
      ]);
    });
    await dataSource.destroy();
  });

  async function withBypass<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      return work(manager);
    });
  }

  async function asTenant<T>(
    kindergartenId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(
        `SELECT set_config('app.kindergarten_id', $1, true)`,
        [kindergartenId],
      );
      return tenantStorage.run(
        {
          kgId: kindergartenId,
          bypass: false,
          entityManager: manager,
        },
        work,
      );
    });
  }

  function makeAccount(
    kindergartenId: string,
    callbackTokenHash = 'a'.repeat(64),
  ): BccMerchantAccount {
    const now = new Date('2026-07-03T08:00:00.000Z');
    const state: BccMerchantAccountState = {
      id: randomUUID(),
      kindergartenId,
      merchantId: `merchant-${kindergartenId.slice(0, 8)}`,
      terminalId: '88888881',
      merchantName: 'Shyraq Test Merchant',
      macKeyEnc: 'aes-gcm-ciphertext',
      environment: 'test',
      status: 'draft',
      callbackTokenHash,
      callbackTokenEnc: 'encrypted-callback-token',
      notifyUsername: `notify-${kindergartenId.slice(0, 8)}`,
      notifyPasswordHash: '$2b$12$not-a-real-password-hash',
      lastConnectionCheckedAt: null,
      lastConnectionResult: null,
      disabledAt: null,
      updatedBy: saasUserId,
      createdAt: now,
      updatedAt: now,
    };
    return BccMerchantAccount.fromState(state);
  }

  it('persists and updates a merchant account through the domain repository', async () => {
    const account = makeAccount(kgA);
    const created = await asTenant(kgA, () => accountRepository.save(account));
    expect(created.kindergartenId).toBe(kgA);
    expect(created.status).toBe('draft');

    const checkedAt = new Date('2026-07-03T08:01:00.000Z');
    account.recordConnectionCheck(
      { success: true, action: '0', rc: '00', rcText: 'OK' },
      checkedAt,
      saasUserId,
    );
    account.activate(new Date('2026-07-03T08:02:00.000Z'), saasUserId);
    const updated = await asTenant(kgA, () => accountRepository.save(account));

    expect(updated.status).toBe('active');
    expect(updated.lastConnectionResult).toEqual({
      success: true,
      action: '0',
      rc: '00',
      rcText: 'OK',
    });
    await expect(
      asTenant(kgA, () => accountRepository.findById(kgA, account.id)),
    ).resolves.toEqual(expect.objectContaining({ id: account.id }));
  });

  it('hides the KG-A account from KG-B and exposes it to KG-A', async () => {
    const account = makeAccount(kgA);
    await asTenant(kgA, () => accountRepository.save(account));

    await expect(
      asTenant(kgB, () => accountRepository.findByKindergartenId(kgA)),
    ).resolves.toBeNull();
    await expect(
      asTenant(kgA, () => accountRepository.findByKindergartenId(kgA)),
    ).resolves.toEqual(expect.objectContaining({ id: account.id }));
  });

  it('rejects a cross-tenant insert through the RLS WITH CHECK policy', async () => {
    await expect(
      asTenant(kgA, async () => {
        const manager = tenantStorage.getStore()!.entityManager!;
        await manager.query(
          `INSERT INTO bcc_merchant_accounts
             (id, kindergarten_id, merchant_id, terminal_id, mac_key_enc,
              callback_token_hash, notify_username, notify_password_hash,
              updated_by)
           VALUES ($1, $2, 'merchant-b', '88888881', 'ciphertext',
                   $3, 'notify-b', 'password-hash', $4)`,
          [randomUUID(), kgB, 'b'.repeat(64), saasUserId],
        );
      }),
    ).rejects.toThrow();
  });

  it('finds only the exact callback account in a scoped bypass transaction', async () => {
    const accountA = makeAccount(kgA, 'a'.repeat(64));
    const accountB = makeAccount(kgB, 'b'.repeat(64));
    await asTenant(kgA, () => accountRepository.save(accountA));
    await asTenant(kgB, () => accountRepository.save(accountB));

    await expect(
      accountRepository.findByCallbackTokenHashBypassRls('a'.repeat(64)),
    ).resolves.toEqual(
      expect.objectContaining({
        id: accountA.id,
        kindergartenId: kgA,
      }),
    );
    await expect(
      accountRepository.findByCallbackTokenHashBypassRls('c'.repeat(64)),
    ).resolves.toBeNull();

    const rowsWithoutScope = (await dataSource.query(
      `SELECT id FROM bcc_merchant_accounts
        WHERE id IN ($1, $2)`,
      [accountA.id, accountB.id],
    )) as Array<{ id: string }>;
    expect(rowsWithoutScope).toHaveLength(0);
  });

  it('upserts and deletes one owner-scoped payment profile', async () => {
    const createdAt = new Date('2026-07-03T08:00:00.000Z');
    const profile = UserPaymentProfile.fromState({
      userId: payerUserId,
      billingPhone: '+77001234567',
      billingAddress: 'Алматы, Абая 1',
      createdAt,
      updatedAt: createdAt,
    });

    await profileRepository.save(profile);
    profile.update(
      '+77771234567',
      'Астана, Достык 2',
      new Date('2026-07-03T09:00:00.000Z'),
    );
    const updated = await profileRepository.save(profile);

    expect(updated.billingPhone).toBe('+77771234567');
    expect(updated.billingAddress).toBe('Астана, Достык 2');
    const [user] = (await dataSource.query(
      `SELECT phone FROM users WHERE id = $1`,
      [payerUserId],
    )) as Array<{ phone: string }>;
    expect(user.phone).not.toBe(updated.billingPhone);

    await expect(profileRepository.deleteByUserId(payerUserId)).resolves.toBe(
      true,
    );
    await expect(
      profileRepository.findByUserId(payerUserId),
    ).resolves.toBeNull();
  });

  it('denies TRUNCATE on both Gate B tables to the runtime role', async () => {
    const [privileges] = (await dataSource.query(`
      SELECT
        has_table_privilege(
          current_user,
          'bcc_merchant_accounts',
          'TRUNCATE'
        ) AS bcc_truncate,
        has_table_privilege(
          current_user,
          'user_payment_profiles',
          'TRUNCATE'
        ) AS profile_truncate
    `)) as Array<{
      bcc_truncate: boolean;
      profile_truncate: boolean;
    }>;

    expect(privileges.bcc_truncate).toBe(false);
    expect(privileges.profile_truncate).toBe(false);
  });
});
