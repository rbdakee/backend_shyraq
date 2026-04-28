/**
 * P5 cross-tenant integration spec — children + child_guardians +
 * child_group_history. Mirrors the P4 organization phantom-row pattern: under
 * `SET LOCAL app.kindergarten_id = '<KG-A>'` only KG-A's rows should be
 * visible, even if SQL explicitly references KG-B's ids.
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
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'P5 children + child_guardians — cross-tenant phantom isolation',
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
    let guardianA: string;
    let guardianB: string;
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
        guardianA = randomUUID();
        guardianB = randomUUID();
        historyA = randomUUID();
        historyB = randomUUID();

        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-${kgB}` },
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
            status: 'card_created',
            current_group_id: null,
            enrollment_date: null,
            archived_at: null,
            archive_reason: null,
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
            status: 'card_created',
            current_group_id: null,
            enrollment_date: null,
            archived_at: null,
            archive_reason: null,
            medical_notes: null,
            allergy_notes: null,
          },
        ]);
        await m.insert(ChildGuardianEntity, [
          {
            id: guardianA,
            kindergarten_id: kgA,
            child_id: childA,
            user_id: userA,
            role: 'primary',
            status: 'approved',
            has_approval_rights: false,
            approved_by: null,
            approved_at: null,
            revoked_by: null,
            revoked_at: null,
            can_pickup: true,
            permissions: {},
            permissions_updated_by: null,
            permissions_updated_at: null,
          },
          {
            id: guardianB,
            kindergarten_id: kgB,
            child_id: childB,
            user_id: userB,
            role: 'primary',
            status: 'approved',
            has_approval_rights: false,
            approved_by: null,
            approved_at: null,
            revoked_by: null,
            revoked_at: null,
            can_pickup: true,
            permissions: {},
            permissions_updated_by: null,
            permissions_updated_at: null,
          },
        ]);
        await m.insert(ChildGroupHistoryEntity, [
          {
            id: historyA,
            kindergarten_id: kgA,
            child_id: childA,
            from_group_id: null,
            to_group_id: null,
            transferred_by_staff_id: staffA,
            reason: null,
          },
          {
            id: historyB,
            kindergarten_id: kgB,
            child_id: childB,
            from_group_id: null,
            to_group_id: null,
            transferred_by_staff_id: staffB,
            reason: null,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM child_group_history WHERE id IN ($1, $2)`, [
          historyA,
          historyB,
        ]);
        await m.query(`DELETE FROM child_guardians WHERE id IN ($1, $2)`, [
          guardianA,
          guardianB,
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

    async function readRows(
      tenant: { kgId: string | null; bypass: boolean },
      table: 'children' | 'child_guardians' | 'child_group_history',
    ): Promise<Array<{ id: string; kindergarten_id: string }>> {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(
              `SELECT id, kindergarten_id FROM ${table} WHERE kindergarten_id IN ($1, $2)`,
              [kgA, kgB],
            );
          }),
      };
      return (await lastValueFrom(
        interceptor.intercept(makeCtx({ tenant }), next),
      )) as Array<{ id: string; kindergarten_id: string }>;
    }

    it('children: KG-A scope sees only KG-A rows', async () => {
      const rows = await readRows({ kgId: kgA, bypass: false }, 'children');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(childA);
    });

    it('child_guardians: KG-A scope sees only KG-A rows', async () => {
      const rows = await readRows(
        { kgId: kgA, bypass: false },
        'child_guardians',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(guardianA);
    });

    it('child_group_history: KG-A scope sees only KG-A rows', async () => {
      const rows = await readRows(
        { kgId: kgA, bypass: false },
        'child_group_history',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(historyA);
    });

    it('bypass=true exposes both tenants on children', async () => {
      const rows = await readRows({ kgId: null, bypass: true }, 'children');
      const seen = new Set(rows.map((r) => r.id));
      expect(seen.has(childA)).toBe(true);
      expect(seen.has(childB)).toBe(true);
    });
  },
);
