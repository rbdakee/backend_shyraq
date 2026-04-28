/**
 * Cross-tenant integration spec for the P4 organization tables — locations,
 * groups, cameras. Mirrors the staff_members phantom-row pattern from the
 * tenant-context interceptor spec but exercises RLS on the new tables.
 *
 * Lives outside the camera/location/group module trees because it spans them
 * all. The shape:
 *   - Seed two kindergartens (KG-A and KG-B) under app.bypass_rls=true.
 *   - Seed one location, one group, and one camera per kindergarten.
 *   - Inside `SET LOCAL app.kindergarten_id = '<KG-A>'` only KG-A's rows
 *     should be visible across all four tables.
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
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'P4 organization tables — cross-tenant phantom isolation',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let userA: string;
    let userB: string;
    let staffA: string;
    let staffB: string;
    let locA: string;
    let locB: string;
    let groupA: string;
    let groupB: string;
    let camA: string;
    let camB: string;

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
        locA = randomUUID();
        locB = randomUUID();
        groupA = randomUUID();
        groupB = randomUUID();
        camA = randomUUID();
        camB = randomUUID();

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
        await m.insert(LocationEntity, [
          {
            id: locA,
            kindergarten_id: kgA,
            name: 'A-loc',
            description: null,
            archived_at: null,
          },
          {
            id: locB,
            kindergarten_id: kgB,
            name: 'B-loc',
            description: null,
            archived_at: null,
          },
        ]);
        await m.insert(GroupEntity, [
          {
            id: groupA,
            kindergarten_id: kgA,
            name: 'A-group',
            capacity: 10,
            age_range_min: null,
            age_range_max: null,
            current_location_id: null,
            archived_at: null,
          },
          {
            id: groupB,
            kindergarten_id: kgB,
            name: 'B-group',
            capacity: 10,
            age_range_min: null,
            age_range_max: null,
            current_location_id: null,
            archived_at: null,
          },
        ]);
        await m.insert(CameraEntity, [
          {
            id: camA,
            kindergarten_id: kgA,
            location_id: locA,
            name: 'A-cam',
            rtsp_url: 'rtsp://a/cam',
            hls_url: null,
            is_active: true,
            archived_at: null,
          },
          {
            id: camB,
            kindergarten_id: kgB,
            location_id: locB,
            name: 'B-cam',
            rtsp_url: 'rtsp://b/cam',
            hls_url: null,
            is_active: true,
            archived_at: null,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM cameras WHERE id IN ($1, $2)`, [camA, camB]);
        await m.query(`DELETE FROM groups WHERE id IN ($1, $2)`, [
          groupA,
          groupB,
        ]);
        await m.query(`DELETE FROM locations WHERE id IN ($1, $2)`, [
          locA,
          locB,
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

    async function readKgRows(
      tenant: { kgId: string | null; bypass: boolean },
      table: 'locations' | 'groups' | 'cameras',
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

    it('isolates locations by tenant', async () => {
      const rows = await readKgRows({ kgId: kgA, bypass: false }, 'locations');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(locA);
    });

    it('isolates groups by tenant', async () => {
      const rows = await readKgRows({ kgId: kgA, bypass: false }, 'groups');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(groupA);
    });

    it('isolates cameras by tenant', async () => {
      const rows = await readKgRows({ kgId: kgA, bypass: false }, 'cameras');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(camA);
    });

    it('exposes both tenants under bypass=true', async () => {
      const rows = await readKgRows({ kgId: null, bypass: true }, 'groups');
      const seen = new Set(rows.map((r) => r.id));
      expect(seen.has(groupA)).toBe(true);
      expect(seen.has(groupB)).toBe(true);
    });
  },
);
