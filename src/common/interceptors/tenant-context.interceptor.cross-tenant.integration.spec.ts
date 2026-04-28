/**
 * Cross-tenant integration spec for the new `staff_members` table introduced
 * in P3. Mirrors the phantom-row pattern from the existing
 * tenant-context.interceptor.integration.spec.ts but exercises RLS on
 * staff_members instead of refresh_tokens.
 *
 * Seeds two kindergartens, two users, and one staff_members row per kg using
 * `app.bypass_rls = 'true'`. Then runs three subtests:
 *   1. Inside `SET LOCAL app.kindergarten_id = '<KG-A>'` only KG-A's staff
 *      row is visible.
 *   2. Under `app.bypass_rls = 'true'` both staff rows are visible.
 *   3. With neither GUC set (a plain transaction) RLS hides every row.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   docker compose -f docker-compose.relational.test.yaml up -d postgres
 *   DATABASE_HOST=localhost DATABASE_PORT=55432 \\
 *     DATABASE_USERNAME=shyraq DATABASE_PASSWORD=shyraq \\
 *     DATABASE_NAME=shyraq npm run migration:run
 *   INTEGRATION_DB=1 DATABASE_HOST=localhost DATABASE_PORT=55432 \\
 *     DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \\
 *     DATABASE_NAME=shyraq npm test -- cross-tenant.integration
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { RefreshTokenEntity } from '@/modules/auth/infrastructure/persistence/relational/entities/refresh-token.entity';
import { SaasUserEntity } from '@/modules/auth/infrastructure/persistence/relational/entities/saas-user.entity';
import { SaasRefreshTokenEntity } from '@/modules/auth/infrastructure/persistence/relational/entities/saas-refresh-token.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { TenantContextInterceptor } from './tenant-context.interceptor';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'TenantContextInterceptor — staff_members cross-tenant phantom',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let userA: string;
    let userB: string;
    let staffA: string;
    let staffB: string;

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
          RefreshTokenEntity,
          SaasUserEntity,
          SaasRefreshTokenEntity,
          StaffMemberEntity,
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
        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-${kgB}` },
        ]);
        await m.insert(UserEntity, [
          { id: userA, phone: `+7700${kgA.slice(0, 7)}`, full_name: 'A' },
          { id: userB, phone: `+7700${kgB.slice(0, 7)}`, full_name: 'B' },
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
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
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

    it('isolates KG-A from KG-B inside SET LOCAL app.kindergarten_id', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const rows = (await ctx!.entityManager!.query(
              `SELECT id, kindergarten_id FROM staff_members WHERE kindergarten_id IN ($1, $2)`,
              [kgA, kgB],
            )) as Array<{ id: string; kindergarten_id: string }>;
            return rows;
          }),
      };
      const result = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgA, bypass: false } }),
          next,
        ),
      )) as Array<{ id: string; kindergarten_id: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].kindergarten_id).toBe(kgA);
      expect(result[0].id).toBe(staffA);
    });

    it('exposes both staff rows under bypass=true', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const rows = (await ctx!.entityManager!.query(
              `SELECT kindergarten_id FROM staff_members WHERE kindergarten_id IN ($1, $2)`,
              [kgA, kgB],
            )) as Array<{ kindergarten_id: string }>;
            return rows;
          }),
      };
      const result = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: null, bypass: true } }),
          next,
        ),
      )) as Array<{ kindergarten_id: string }>;
      const seen = new Set(result.map((r) => r.kindergarten_id));
      expect(seen.has(kgA)).toBe(true);
      expect(seen.has(kgB)).toBe(true);
    });

    it('without GUCs RLS hides every staff row from a non-owner role', async () => {
      // Whether RLS hides everything depends on whether the connection's role
      // is BYPASSRLS / superuser. The migration role (`shyraq`) bypasses RLS;
      // the runtime role (`shyraq_app`) does not. Skip this assertion when
      // run as a privileged role to keep the spec robust across environments.
      const username = (process.env.DATABASE_USERNAME ?? '').toLowerCase();
      if (username !== 'shyraq_app') {
        // Privileged role — RLS does not apply, every row is visible. Just
        // verify the rows are at least reachable so the spec keeps a positive
        // signal when run with a superuser/BYPASSRLS credential.
        const rows = await dataSource.query(
          `SELECT id FROM staff_members WHERE id IN ($1, $2)`,
          [staffA, staffB],
        );
        expect(rows.length).toBeGreaterThanOrEqual(2);
        return;
      }
      const visible = await dataSource.transaction(async (m) => {
        const rows = (await m.query(
          `SELECT id FROM staff_members WHERE id IN ($1, $2)`,
          [staffA, staffB],
        )) as unknown[];
        return rows;
      });
      expect(visible).toHaveLength(0);
    });
  },
);
