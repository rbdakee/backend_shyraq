/**
 * B22a T9 — `child_status_history` cross-tenant phantom-row isolation.
 *
 * Mirrors `children-cross-tenant.integration.spec.ts`: under
 * `SET LOCAL app.kindergarten_id = '<KG-A>'` only KG-A's status-history
 * rows should be visible, even if SQL explicitly references KG-B's ids.
 * `bypass_rls=true` exposes both tenants (super-admin path).
 *
 * Self-skips when `INTEGRATION_DB !== '1'`.
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { ChildStatusHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-status-history.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B22a T9 child_status_history — cross-tenant phantom isolation',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let userA: string;
    let userB: string;
    let staffA: string;
    let staffB: string;
    let childA: string;
    let childB: string;
    let historyA: string;
    let historyB: string;

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
          ChildStatusHistoryEntity,
        ],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        userB = randomUUID();
        staffA = randomUUID();
        staffB = randomUUID();
        childA = randomUUID();
        childB = randomUUID();
        historyA = randomUUID();
        historyB = randomUUID();

        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `csh-kg-a-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `csh-kg-b-${kgB}` },
        ]);
        await m.insert(UserEntity, [
          { id: userA, phone: `+7700${kgA.slice(0, 7)}`, full_name: 'A' },
          { id: userB, phone: `+7711${kgB.slice(0, 7)}`, full_name: 'B' },
        ]);
        await m.insert(StaffMemberEntity, [
          {
            id: staffA,
            kindergarten_id: kgA,
            user_id: userA,
            role: 'admin',
            specialist_type: null,
            is_active: true,
          },
          {
            id: staffB,
            kindergarten_id: kgB,
            user_id: userB,
            role: 'admin',
            specialist_type: null,
            is_active: true,
          },
        ]);
        await m.insert(ChildEntity, [
          {
            id: childA,
            kindergarten_id: kgA,
            iin: null,
            full_name: 'Aigerim',
            date_of_birth: '2021-09-15',
            gender: 'f',
            photo_url: null,
            status: 'archived',
            current_group_id: null,
            enrollment_date: null,
            archived_at: new Date(),
            archive_reason: 'Перевод',
            medical_notes: null,
            allergy_notes: null,
          },
          {
            id: childB,
            kindergarten_id: kgB,
            iin: null,
            full_name: 'Bota',
            date_of_birth: '2021-09-15',
            gender: 'f',
            photo_url: null,
            status: 'archived',
            current_group_id: null,
            enrollment_date: null,
            archived_at: new Date(),
            archive_reason: 'Family relocated',
            medical_notes: null,
            allergy_notes: null,
          },
        ]);
        const now = new Date();
        await m.insert(ChildStatusHistoryEntity, [
          {
            id: historyA,
            kindergarten_id: kgA,
            child_id: childA,
            previous_status: 'active',
            new_status: 'archived',
            previous_archive_reason: null,
            archive_reason: 'Перевод',
            changed_by_user_id: userA,
            changed_at: now,
          },
          {
            id: historyB,
            kindergarten_id: kgB,
            child_id: childB,
            previous_status: 'active',
            new_status: 'archived',
            previous_archive_reason: null,
            archive_reason: 'Family relocated',
            changed_by_user_id: userB,
            changed_at: now,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM child_status_history WHERE id IN ($1, $2)`, [
          historyA,
          historyB,
        ]);
        await m.query(`DELETE FROM children WHERE id IN ($1, $2)`, [
          childA,
          childB,
        ]);
        await m.query(`DELETE FROM staff_members WHERE id IN ($1, $2)`, [
          staffA,
          staffB,
        ]);
        await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
          kgA,
          kgB,
        ]);
      });
      await dataSource.destroy();
    });

    function makeCtx(req: Record<string, unknown>): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    }

    async function readRows(tenant: {
      kgId: string | null;
      bypass: boolean;
    }): Promise<Array<{ id: string; kindergarten_id: string }>> {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(
              `SELECT id, kindergarten_id FROM child_status_history WHERE kindergarten_id IN ($1, $2)`,
              [kgA, kgB],
            );
          }),
      };
      return (await lastValueFrom(
        interceptor.intercept(makeCtx({ tenant }), next),
      )) as Array<{ id: string; kindergarten_id: string }>;
    }

    it('isolates kg_A scope so it sees only its own status-history row', async () => {
      const rows = await readRows({ kgId: kgA, bypass: false });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(historyA);
    });

    it('isolates kg_B scope so it sees only its own status-history row', async () => {
      const rows = await readRows({ kgId: kgB, bypass: false });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(historyB);
    });

    it('exposes both tenants when bypass_rls=true (super-admin path)', async () => {
      const rows = await readRows({ kgId: null, bypass: true });
      const seen = new Set(rows.map((r) => r.id));
      expect(seen.has(historyA)).toBe(true);
      expect(seen.has(historyB)).toBe(true);
    });
  },
);
