/**
 * HIGH#2 regression — `RefreshTokenRelationalRepository.revokeAllByUserId`
 * MUST revoke active refresh-token rows for the given `user_id` ACROSS every
 * kindergarten the user is a member of.
 *
 * `refresh_tokens` has FORCE ROW LEVEL SECURITY (see migration
 * 1777593601000-AuthAndUsersTables, policy `tenant_isolation`). Earlier
 * implementations issued the UPDATE through the ambient
 * `tenantStorage`-bound EntityManager, which carries the caller's per-TX
 * `app.kindergarten_id` GUC — so the UPDATE silently filtered to one tenant
 * and left other-kg sessions for the same user active. This test simulates
 * that ambient context by setting `app.kindergarten_id` to kg-A on the outer
 * transaction, calling `revokeAllByUserId`, and asserting that BOTH the
 * kg-A and kg-B refresh rows for the user are revoked.
 *
 * The repository solves this by opening a fresh-connection sub-transaction
 * (off `this.repo.manager`, NOT the ambient one) and `SET LOCAL
 * app.bypass_rls='true'` inside it.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';
import { RefreshTokenRelationalRepository } from './refresh-token.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'RefreshTokenRelationalRepository.revokeAllByUserId — cross-tenant',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let userId: string;
    let rowAId: string;
    let rowBId: string;
    let rowOtherUserId: string;
    let otherUserId: string;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: process.env.DATABASE_PORT
          ? parseInt(process.env.DATABASE_PORT, 10)
          : 5432,
        username: process.env.DATABASE_USERNAME ?? 'shyraq',
        password: process.env.DATABASE_PASSWORD ?? 'shyraq',
        database: process.env.DATABASE_NAME ?? 'shyraq',
        entities: [
          KindergartenEntity,
          UserEntity,
          StaffMemberEntity,
          LocationEntity,
          GroupEntity,
          GroupMentorEntity,
          CameraEntity,
          ChildEntity,
          ChildGuardianEntity,
          ChildGroupHistoryEntity,
          RefreshTokenEntity,
        ],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        kgA = randomUUID();
        kgB = randomUUID();
        userId = randomUUID();
        otherUserId = randomUUID();
        rowAId = randomUUID();
        rowBId = randomUUID();
        rowOtherUserId = randomUUID();

        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-rt-rev-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-rt-rev-${kgB}` },
        ]);
        // Random 8-digit suffix per user to avoid colliding with other
        // integration specs that may have inserted users with the same phone.
        const ph = (): string => {
          const n = Math.floor(Math.random() * 1e8)
            .toString()
            .padStart(8, '0');
          return `+7700${n}`;
        };
        await m.insert(UserEntity, [
          { id: userId, phone: ph(), full_name: 'Multi-Kg User' },
          { id: otherUserId, phone: ph(), full_name: 'Other User' },
        ]);
        const future = new Date(Date.now() + 7 * 24 * 3600 * 1000);
        await m.insert(RefreshTokenEntity, [
          {
            id: rowAId,
            user_id: userId,
            kindergarten_id: kgA,
            token_hash: `hash-A-${rowAId}`,
            device_id: 'dev-A',
            ip_address: null,
            expires_at: future,
          },
          {
            id: rowBId,
            user_id: userId,
            kindergarten_id: kgB,
            token_hash: `hash-B-${rowBId}`,
            device_id: 'dev-B',
            ip_address: null,
            expires_at: future,
          },
          {
            // Different user; must NOT be touched by revokeAllByUserId(userId).
            id: rowOtherUserId,
            user_id: otherUserId,
            kindergarten_id: kgA,
            token_hash: `hash-other-${rowOtherUserId}`,
            device_id: 'dev-other',
            ip_address: null,
            expires_at: future,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM refresh_tokens WHERE id IN ($1, $2, $3)`, [
          rowAId,
          rowBId,
          rowOtherUserId,
        ]);
        await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
          userId,
          otherUserId,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
          kgA,
          kgB,
        ]);
      });
      await dataSource.destroy();
    });

    it('revokes refresh tokens in every kindergarten under ambient kg-A GUC', async () => {
      const repo = new RefreshTokenRelationalRepository(
        dataSource.getRepository(RefreshTokenEntity),
      );
      const now = new Date('2026-05-04T12:00:00.000Z');

      // Simulate the ambient TenantContextInterceptor TX (kg-A scope) wrapping
      // the call. revokeAllByUserId must transcend that scope and revoke kg-B
      // too. We do NOT thread an entityManager through tenantStorage here; the
      // repository deliberately ignores the ambient manager for this method
      // (uses fresh-connection bypass instead).
      await dataSource.transaction(async (outer) => {
        // SET LOCAL inside the outer TX — mimics what TenantContextInterceptor
        // does in production.
        await outer.query(`SET LOCAL app.kindergarten_id = '${kgA}'`);
        await repo.revokeAllByUserId(userId, now);
      });

      // Re-read all three rows under bypass_rls to bypass the policy and see
      // the truth.
      const rows = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT id, user_id, kindergarten_id, revoked_at
           FROM refresh_tokens
           WHERE id IN ($1, $2, $3)
           ORDER BY id`,
          [rowAId, rowBId, rowOtherUserId],
        );
      });

      const byId = new Map<
        string,
        {
          id: string;
          user_id: string;
          kindergarten_id: string;
          revoked_at: Date | null;
        }
      >();
      for (const r of rows as Array<{
        id: string;
        user_id: string;
        kindergarten_id: string;
        revoked_at: Date | null;
      }>) {
        byId.set(r.id, r);
      }

      // Both of the multi-kg user's rows are revoked.
      expect(byId.get(rowAId)?.revoked_at).not.toBeNull();
      expect(byId.get(rowBId)?.revoked_at).not.toBeNull();
      // The unrelated user's row is intact.
      expect(byId.get(rowOtherUserId)?.revoked_at).toBeNull();
    });
  },
);
