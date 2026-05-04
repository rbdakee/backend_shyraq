/**
 * Concurrent enrollment.transition(card_created) race.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern enrollment-card-created.race.integration
 *
 * What this guards: EnrollmentService.transition's `card_created` edge does
 *   1. read enrollment
 *   2. validate card_created payload
 *   3. childService.createChild + inviteGuardian   ← side-effects
 *   4. enrollmentRepo.update(...)                  ← plain UPDATE, no guard
 *
 * Two concurrent transitions can both pass (1)-(2), both create child rows,
 * both write status='card_created' (last-write-wins). Loser's child is then
 * an orphan because enrollment.assigned_child_id only points at the winner.
 *
 * Fix: EnrollmentRepository.updateWithExpectedStatus emits
 *   UPDATE enrollments SET ... WHERE id=$1 AND kindergarten_id=$2 AND status=$3
 * Loser sees `affected = 0` → service throws
 * EnrollmentTransitionConflictError → ambient TX rollback drops the loser's
 * createChild/inviteGuardian writes too.
 *
 * The spec verifies the conditional-UPDATE primitive directly: two
 * concurrent calls to `updateWithExpectedStatus(in_processing → card_created)`
 * — only one observes `affected > 0`, the other observes false.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Enrollment } from '@/modules/enrollment/domain/entities/enrollment.entity';
import { EnrollmentEntity } from '@/modules/enrollment/infrastructure/persistence/relational/entities/enrollment.entity';
import { EnrollmentRelationalRepository } from '@/modules/enrollment/infrastructure/persistence/relational/repositories/enrollment-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'EnrollmentRepository.updateWithExpectedStatus — concurrent transition race',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let enrollmentId: string;

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
        entities: [EnrollmentEntity],
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
      enrollmentId = randomUUID();
      const slug = `enr-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Enr Race KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO enrollments
             (id, kindergarten_id, contact_name, contact_phone, child_name,
              child_dob, status, status_changed_at)
           VALUES ($1, $2, 'Parent', '+77011112233', 'Race Kid',
                   '2021-08-15', 'in_processing', NOW())`,
          [enrollmentId, kgId],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM enrollments WHERE kindergarten_id = $1`, [
          kgId,
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

    it('serializes 2 concurrent transitions to card_created — exactly 1 winner + 1 loser', async () => {
      const repo = new EnrollmentRelationalRepository(
        dataSource.getRepository(EnrollmentEntity),
      );

      // Build a domain Enrollment shaped like a card_created post-mutation.
      // Each concurrent call uses its own copy.
      function buildCardCreated(): Enrollment {
        return Enrollment.hydrate({
          id: enrollmentId,
          kindergartenId: kgId,
          childId: randomUUID(), // each caller writes a different child id
          contactName: 'Parent',
          contactPhone: '+77011112233',
          childName: 'Race Kid',
          childDob: new Date('2021-08-15T00:00:00.000Z'),
          childIin: null,
          status: 'card_created',
          source: null,
          notes: null,
          assignedTo: null,
          statusChangedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      const results = await Promise.all([
        runInTenantTx(() =>
          repo.updateWithExpectedStatus(
            kgId,
            buildCardCreated(),
            'in_processing',
          ),
        ),
        runInTenantTx(() =>
          repo.updateWithExpectedStatus(
            kgId,
            buildCardCreated(),
            'in_processing',
          ),
        ),
      ]);

      const winners = results.filter((r) => r === true);
      const losers = results.filter((r) => r === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      // DB invariant: row is now `card_created`.
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(`SELECT status FROM enrollments WHERE id = $1`, [
          enrollmentId,
        ]);
      })) as Array<{ status: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('card_created');
    });

    it('returns false when expected status no longer matches (sequential conflict)', async () => {
      const repo = new EnrollmentRelationalRepository(
        dataSource.getRepository(EnrollmentEntity),
      );
      function buildCardCreated(): Enrollment {
        return Enrollment.hydrate({
          id: enrollmentId,
          kindergartenId: kgId,
          childId: randomUUID(),
          contactName: 'Parent',
          contactPhone: '+77011112233',
          childName: 'Race Kid',
          childDob: new Date('2021-08-15T00:00:00.000Z'),
          childIin: null,
          status: 'card_created',
          source: null,
          notes: null,
          assignedTo: null,
          statusChangedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      // First call wins (status: in_processing → card_created).
      const first = await runInTenantTx(() =>
        repo.updateWithExpectedStatus(
          kgId,
          buildCardCreated(),
          'in_processing',
        ),
      );
      expect(first).toBe(true);
      // Second call loses (row is now card_created, not in_processing).
      const second = await runInTenantTx(() =>
        repo.updateWithExpectedStatus(
          kgId,
          buildCardCreated(),
          'in_processing',
        ),
      );
      expect(second).toBe(false);
    });
  },
);
