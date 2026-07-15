/**
 * Cross-tenant integration spec for `audit_log` (CLAUDE.md §9.11).
 *
 * The audit trail carries `before` / `after` snapshots of tenant rows — a leak
 * here is worse than a leak on the table it describes, since one row exposes
 * both the ids and the field values a correction moved between. RLS is
 * therefore verified against the real policy, not a fake.
 *
 * Shape mirrors `group/organization-cross-tenant.integration.spec.ts`:
 *   - Seed two kindergartens (KG-A and KG-B), each with a user + staff member,
 *     under `app.bypass_rls = 'true'`.
 *   - Seed one audit_log row per kindergarten.
 *   - Inside `SET LOCAL app.kindergarten_id = '<KG-A>'` only KG-A's row is
 *     visible — KG-B's is a phantom: absent from SELECT, and unreachable by a
 *     direct id lookup.
 *   - A cross-tenant INSERT is refused by the policy's WITH CHECK clause, so a
 *     mis-scoped writer cannot plant rows in another tenant either.
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
import { AuditLogTypeOrmEntity } from './infrastructure/persistence/relational/entities/audit-log.typeorm.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('audit_log — cross-tenant phantom isolation', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgA: string;
  let kgB: string;
  let userA: string;
  let userB: string;
  let staffA: string;
  let staffB: string;
  let auditA: string;
  let auditB: string;
  let eventA: string;
  let eventB: string;

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
        AuditLogTypeOrmEntity,
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
      auditA = randomUUID();
      auditB = randomUUID();
      // `entity_id` has no FK — audit rows outlive the entities they describe,
      // so a synthetic id is enough to exercise the policy.
      eventA = randomUUID();
      eventB = randomUUID();

      await m.insert(KindergartenEntity, [
        { id: kgA, name: 'KG-A', slug: `kg-a-${kgA}` },
        { id: kgB, name: 'KG-B', slug: `kg-b-${kgB}` },
      ]);
      await m.insert(UserEntity, [
        { id: userA, phone: `+7702${kgA.slice(0, 7)}`, full_name: 'A' },
        { id: userB, phone: `+7712${kgB.slice(0, 7)}`, full_name: 'B' },
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
      await m.insert(AuditLogTypeOrmEntity, [
        {
          id: auditA,
          kindergarten_id: kgA,
          entity_type: 'attendance_event',
          entity_id: eventA,
          action: 'update',
          actor_user_id: userA,
          actor_staff_id: staffA,
          before: { notes: 'A-before' } as never,
          after: { notes: 'A-after' } as never,
        },
        {
          id: auditB,
          kindergarten_id: kgB,
          entity_type: 'attendance_event',
          entity_id: eventB,
          action: 'update',
          actor_user_id: userB,
          actor_staff_id: staffB,
          before: { notes: 'B-before' } as never,
          after: { notes: 'B-after' } as never,
        },
      ]);
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`DELETE FROM audit_log WHERE id IN ($1, $2)`, [
        auditA,
        auditB,
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

  /** Runs `work` inside the tenant TX the interceptor opens, as HTTP would. */
  async function inTenant<T>(
    tenant: { kgId: string | null; bypass: boolean },
    work: (m: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T> {
    const interceptor = new TenantContextInterceptor(dataSource);
    const next = {
      handle: () =>
        defer(async () => {
          const ctx = tenantStorage.getStore();
          return work(ctx!.entityManager!);
        }),
    };
    return (await lastValueFrom(
      interceptor.intercept(makeCtx({ tenant }), next),
    )) as T;
  }

  async function readAuditRows(tenant: {
    kgId: string | null;
    bypass: boolean;
  }): Promise<Array<{ id: string; kindergarten_id: string }>> {
    return inTenant(
      tenant,
      (m) =>
        m.query(
          `SELECT id, kindergarten_id FROM audit_log WHERE kindergarten_id IN ($1, $2)`,
          [kgA, kgB],
        ) as Promise<Array<{ id: string; kindergarten_id: string }>>,
    );
  }

  it('isolates audit_log rows by tenant', async () => {
    const rows = await readAuditRows({ kgId: kgA, bypass: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(auditA);
    expect(rows[0].kindergarten_id).toBe(kgA);
  });

  it('returns no row when KG-A looks up KG-B audit id directly', async () => {
    // The phantom-row check: knowing the id is not enough to read it.
    const rows = await inTenant(
      { kgId: kgA, bypass: false },
      (m) =>
        m.query(`SELECT id FROM audit_log WHERE id = $1`, [auditB]) as Promise<
          Array<{ id: string }>
        >,
    );
    expect(rows).toHaveLength(0);
  });

  it('hides the before/after snapshots of another tenant', async () => {
    // The snapshots are the sensitive payload — assert they never materialise.
    const rows = await inTenant(
      { kgId: kgA, bypass: false },
      (m) =>
        m.query(`SELECT before, after FROM audit_log WHERE entity_id = $1`, [
          eventB,
        ]) as Promise<Array<{ before: unknown; after: unknown }>>,
    );
    expect(rows).toHaveLength(0);
  });

  it('rejects an insert scoped to another tenant', async () => {
    // WITH CHECK — a mis-scoped writer cannot plant rows in KG-B either.
    await expect(
      inTenant({ kgId: kgA, bypass: false }, (m) =>
        m.query(
          `INSERT INTO audit_log (id, kindergarten_id, entity_type, entity_id, action)
             VALUES ($1, $2, 'attendance_event', $3, 'create')`,
          [randomUUID(), kgB, randomUUID()],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('exposes both tenants under bypass=true', async () => {
    const rows = await readAuditRows({ kgId: null, bypass: true });
    const seen = new Set(rows.map((r) => r.id));
    expect(seen.has(auditA)).toBe(true);
    expect(seen.has(auditB)).toBe(true);
  });
});
