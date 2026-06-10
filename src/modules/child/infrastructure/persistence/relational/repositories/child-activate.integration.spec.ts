/**
 * Integration coverage for the `card_created → active` conditional UPDATE
 * (`ChildRelationalRepository.activate`) against a real Postgres with RLS.
 *
 * Runs the repo method INSIDE a tenant-scoped transaction (SET LOCAL
 * app.kindergarten_id + tenantStorage.run) exactly like the production
 * pipeline (TenantContextInterceptor), so the `manager()` helper resolves
 * to the per-TX EntityManager and RLS is exercised — not bypassed. Connects
 * as the runtime role (DATABASE_USERNAME=shyraq_app, NOBYPASSRLS) so the
 * policy actually applies.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB.
 */
import 'reflect-metadata';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
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
import { ChildRelationalRepository } from './child.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'ChildRelationalRepository.activate (card_created -> active)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let childCardCreated: string; // kg_A, status=card_created
    let childArchived: string; // kg_A, status=archived

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
        childCardCreated = randomUUID();
        childArchived = randomUUID();

        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-act-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-act-${kgB}` },
        ]);
        await m.insert(ChildEntity, [
          {
            id: childCardCreated,
            kindergarten_id: kgA,
            iin: null,
            full_name: 'Card Created Bala',
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
            id: childArchived,
            kindergarten_id: kgA,
            iin: null,
            full_name: 'Archived Bala',
            date_of_birth: '2020-01-01',
            gender: 'f',
            photo_url: null,
            status: 'archived',
            current_group_id: null,
            enrollment_date: null,
            archived_at: new Date(),
            archive_reason: 'left',
            medical_notes: null,
            allergy_notes: null,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM children WHERE id IN ($1, $2)`, [
          childCardCreated,
          childArchived,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
          kgA,
          kgB,
        ]);
      });
      await dataSource.destroy();
    });

    /**
     * Runs `fn` inside a tenant-scoped TX for `kgId` — mirrors
     * TenantContextInterceptor so `repo.manager()` resolves to the per-TX
     * EntityManager with `app.kindergarten_id` set (RLS applies).
     */
    async function inTenant<T>(
      kgId: string,
      fn: (repo: ChildRelationalRepository, m: EntityManager) => Promise<T>,
    ): Promise<T> {
      return dataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
          kgId,
        ]);
        return tenantStorage.run(
          { kgId, bypass: false, entityManager: m },
          async () => {
            const repo = new ChildRelationalRepository(
              dataSource.getRepository(ChildEntity),
              dataSource,
            );
            return fn(repo, m);
          },
        );
      });
    }

    it('flips card_created -> active, sets enrollment_date, returns activated', async () => {
      // Midday UTC so the DATE-column truncation lands on the same calendar
      // day regardless of the DB session timezone (a midnight-UTC input would
      // be timezone-fragile — `date` columns truncate in the session TZ).
      const activatedAt = new Date('2026-06-10T12:00:00.000Z');
      const result = await inTenant(kgA, (repo) =>
        repo.activate(kgA, childCardCreated, activatedAt),
      );

      expect(result.kind).toBe('activated');
      if (result.kind === 'activated') {
        expect(result.child.status.value).toBe('active');
        expect(result.child.id).toBe(childCardCreated);
        // enrollment_date was NULL before; the UPDATE sets it. `enrollment_date`
        // is a DATE column — RETURNING * comes back as a 'YYYY-MM-DD' string and
        // ChildMapper normalises it to a Date. We assert it is now populated;
        // the exact day is TZ-dependent (not part of activate's contract — it
        // just threads `now` through).
        expect(result.child.enrollmentDate).toBeInstanceOf(Date);
      }

      // Persisted: a fresh bypass-RLS read sees status='active' + a non-null
      // enrollment_date.
      const row = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT status, enrollment_date FROM children WHERE id = $1`,
          [childCardCreated],
        )) as Array<{ status: string; enrollment_date: string | Date | null }>;
        return rows[0];
      });
      expect(row.status).toBe('active');
      expect(row.enrollment_date).not.toBeNull();
    });

    it('returns not-card-created on a second activate (already active)', async () => {
      const result = await inTenant(kgA, (repo) =>
        repo.activate(kgA, childCardCreated, new Date()),
      );
      expect(result.kind).toBe('not-card-created');
    });

    it('returns not-card-created for an archived child', async () => {
      const result = await inTenant(kgA, (repo) =>
        repo.activate(kgA, childArchived, new Date()),
      );
      expect(result.kind).toBe('not-card-created');
    });

    it('returns not-found for a non-existent child', async () => {
      const result = await inTenant(kgA, (repo) =>
        repo.activate(kgA, randomUUID(), new Date()),
      );
      expect(result.kind).toBe('not-found');
    });

    it('returns not-found when the child belongs to another kg (RLS scope)', async () => {
      // Scope into kg_B but target kg_A's child — RLS hides it, so the
      // conditional UPDATE matches 0 rows and the follow-up SELECT (also
      // RLS-scoped to kg_B) sees nothing → not-found.
      const result = await inTenant(kgB, (repo) =>
        repo.activate(kgB, childArchived, new Date()),
      );
      expect(result.kind).toBe('not-found');
    });
  },
);
