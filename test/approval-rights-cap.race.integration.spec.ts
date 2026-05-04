/**
 * Concurrent has_approval_rights cap (≤2 per child) race.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern approval-rights-cap.race.integration
 *
 * What this guards: BP §4 (Guardian Permissions Matrix) constrains
 * has_approval_rights to ≤2 active holders per child. Two concurrent grants
 * (admin double-click, parallel approvals) can both read count=1 from the
 * naive read+check+write sequence, both pass the check, both write — the
 * child ends up with 3 holders, which silently breaks the matrix.
 *
 * Fix: ChildGuardianRepository.acquireApprovalRightsLock(kg, childId)
 * issues `pg_advisory_xact_lock(hashtext('approval-rights:'||kg||':'||child)::bigint)`,
 * released at the ambient TX boundary. Concurrent grants serialize on the
 * lock; the second observer sees the updated count and trips
 * MaxApprovalRightsExceededError.
 *
 * The spec runs 5 concurrent "grant approval rights to a *new* approved
 * guardian" sequences, each in its own tenant TX. With the existing PRIMARY
 * (which already holds rights) on the child, the cap = 2, so:
 *   - Exactly 1 of the 5 calls flips a row to has_approval_rights=true
 *   - The other 4 trip the cap and end with the row unchanged
 *
 * The DB ends with exactly 2 has_approval_rights=true rows (the PRIMARY
 * + the one winning grant).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { ChildGuardianRelationalRepository } from '@/modules/child/infrastructure/persistence/relational/repositories/child-guardian.repository';
import { MaxApprovalRightsExceededError } from '@/modules/child/domain/errors/max-approval-rights-exceeded.error';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'ChildGuardianRepository.acquireApprovalRightsLock — concurrent ≤2 cap race',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let primaryUserId: string;
    let primaryGuardianId: string;
    let candidateGuardianIds: string[];
    let candidateUserIds: string[];

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
        entities: [ChildGuardianEntity],
        synchronize: false,
        logging: false,
        poolSize: 10,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    beforeEach(async () => {
      kgId = randomUUID();
      childId = randomUUID();
      primaryUserId = randomUUID();
      primaryGuardianId = randomUUID();
      candidateUserIds = Array.from({ length: 5 }, () => randomUUID());
      candidateGuardianIds = Array.from({ length: 5 }, () => randomUUID());

      const slug = `appr-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Approval Race KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'P')`,
          [primaryUserId, `+770111${kgId.slice(0, 5).replace(/[^0-9]/g, '0')}`],
        );
        for (let i = 0; i < candidateUserIds.length; i++) {
          await m.query(
            `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'C')`,
            [
              candidateUserIds[i],
              `+770222${kgId.slice(0, 4).replace(/[^0-9]/g, '0')}${i}`,
            ],
          );
        }
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Race Child', '2020-01-01', 'active')`,
          [childId, kgId],
        );
        // Primary guardian already approved with has_approval_rights=true —
        // counts as 1 of 2 against the cap.
        await m.query(
          `INSERT INTO child_guardians
             (id, kindergarten_id, child_id, user_id, role, status,
              has_approval_rights, can_pickup, permissions, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, 'primary', 'approved', true, true, '{}', $4, NOW())`,
          [primaryGuardianId, kgId, childId, primaryUserId],
        );
        // 5 candidate guardians, all approved but none yet holds rights.
        for (let i = 0; i < candidateGuardianIds.length; i++) {
          await m.query(
            `INSERT INTO child_guardians
               (id, kindergarten_id, child_id, user_id, role, status,
                has_approval_rights, can_pickup, permissions, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 'secondary', 'approved', false, false, '{}', $5, NOW())`,
            [
              candidateGuardianIds[i],
              kgId,
              childId,
              candidateUserIds[i],
              primaryUserId,
            ],
          );
        }
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM child_guardians WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          [primaryUserId, ...candidateUserIds],
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    });

    async function runInTenantTx<T>(fn: () => Promise<T>): Promise<T> {
      return dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        return tenantStorage.run(
          { kgId, bypass: false, entityManager: manager },
          fn,
        );
      });
    }

    /**
     * Mirrors ChildService.toggleGuardianApprovalRights's relevant block:
     * acquire lock → count → throw if cap → flip flag.
     */
    async function tryGrantRights(
      repo: ChildGuardianRelationalRepository,
      guardianId: string,
    ): Promise<'granted' | 'capped'> {
      await repo.acquireApprovalRightsLock(kgId, childId);
      const current = await repo.countApprovalRights(kgId, childId);
      if (current >= 2) {
        throw new MaxApprovalRightsExceededError(childId);
      }
      const m = tenantStorage.getStore()?.entityManager;
      if (!m) throw new Error('no ambient TX');
      await m
        .getRepository(ChildGuardianEntity)
        .update({ id: guardianId }, { has_approval_rights: true });
      return 'granted';
    }

    it('serializes 5 concurrent grants — exactly 1 winner + 4 capped + final count = 2', async () => {
      const repo = new ChildGuardianRelationalRepository(
        dataSource.getRepository(ChildGuardianEntity),
        dataSource,
      );

      const results = await Promise.all(
        candidateGuardianIds.map((gid) =>
          runInTenantTx(async () => {
            try {
              return await tryGrantRights(repo, gid);
            } catch (err) {
              if (err instanceof MaxApprovalRightsExceededError) {
                return 'capped' as const;
              }
              throw err;
            }
          }),
        ),
      );

      const granted = results.filter((r) => r === 'granted');
      const capped = results.filter((r) => r === 'capped');
      expect(granted).toHaveLength(1);
      expect(capped).toHaveLength(4);

      // DB invariant: exactly 2 has_approval_rights=true rows (PRIMARY + 1 winner)
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT COUNT(*)::int AS cnt
           FROM child_guardians
           WHERE child_id = $1
             AND has_approval_rights = true
             AND status = 'approved'`,
          [childId],
        );
      })) as Array<{ cnt: number }>;
      expect(rows[0].cnt).toBe(2);
    });
  },
);
