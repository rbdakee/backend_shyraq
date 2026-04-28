/**
 * Integration spec for the partial-unique index `idx_group_mentors_one_active`.
 *
 * Asserts the DB-level invariant — the application code closes the previously
 * active row before inserting a new one, but on a race the unique index is
 * the last line of defense:
 *
 *   - Inserting two rows with `unassigned_at IS NULL` for the same group
 *     fails with 23505 (unique_violation).
 *   - After UPDATE-ing the first row's `unassigned_at` to a non-null
 *     timestamp, inserting a second active row succeeds.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so unit-test runs stay green on
 * machines without a configured tenant DB. Run with the same env-var recipe
 * as the other integration specs (see tenant-context.interceptor spec).
 */
import 'reflect-metadata';
import { DataSource, QueryFailedError } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { GroupEntity } from './entities/group.entity';
import { GroupMentorEntity } from './entities/group-mentor.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

interface PgError {
  code?: string;
}

describeIntegration(
  'group_mentors — idx_group_mentors_one_active partial-unique invariant',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let userIdA: string;
    let userIdB: string;
    let staffA: string;
    let staffB: string;
    let groupId: string;

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
        ],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      // Bypass RLS so seed runs regardless of connecting role.
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        kgId = randomUUID();
        userIdA = randomUUID();
        userIdB = randomUUID();
        staffA = randomUUID();
        staffB = randomUUID();
        groupId = randomUUID();
        await m.insert(KindergartenEntity, [
          { id: kgId, name: 'KG-Mentor', slug: `kg-m-${kgId}` },
        ]);
        await m.insert(UserEntity, [
          { id: userIdA, phone: `+7700${kgId.slice(0, 7)}`, full_name: 'A' },
          { id: userIdB, phone: `+7711${kgId.slice(0, 7)}`, full_name: 'B' },
        ]);
        await m.insert(StaffMemberEntity, [
          {
            id: staffA,
            kindergarten_id: kgId,
            user_id: userIdA,
            role: 'mentor',
            specialist_type: null,
            is_active: true,
          },
          {
            id: staffB,
            kindergarten_id: kgId,
            user_id: userIdB,
            role: 'mentor',
            specialist_type: null,
            is_active: true,
          },
        ]);
        await m.insert(GroupEntity, [
          {
            id: groupId,
            kindergarten_id: kgId,
            name: 'Mentor-Test-Group',
            capacity: 10,
            age_range_min: null,
            age_range_max: null,
            current_location_id: null,
            archived_at: null,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM group_mentors WHERE group_id = $1`, [
          groupId,
        ]);
        await m.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
        await m.query(`DELETE FROM staff_members WHERE id IN ($1, $2)`, [
          staffA,
          staffB,
        ]);
        await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
          userIdA,
          userIdB,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
      await dataSource.destroy();
    });

    /**
     * Use bypass_rls so this spec works whether it's run as `shyraq` (BYPASS)
     * or `shyraq_app` (NOBYPASSRLS). The unique index is independent of RLS;
     * we just need rows to be writable.
     */
    async function withBypass<T>(
      fn: (m: import('typeorm').EntityManager) => Promise<T>,
    ): Promise<T> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return fn(m);
      });
    }

    it('rejects two active rows on the same group (23505)', async () => {
      const firstId = randomUUID();
      const secondId = randomUUID();

      // Run inside a *single* transaction so the second insert fires the
      // unique index against the first one already visible (same TX sees
      // its own writes).
      let caught: unknown = null;
      try {
        await withBypass(async (m) => {
          await m.insert(GroupMentorEntity, {
            id: firstId,
            kindergarten_id: kgId,
            group_id: groupId,
            staff_member_id: staffA,
            is_primary: true,
            assigned_at: new Date(),
            unassigned_at: null,
          });
          await m.insert(GroupMentorEntity, {
            id: secondId,
            kindergarten_id: kgId,
            group_id: groupId,
            staff_member_id: staffB,
            is_primary: true,
            assigned_at: new Date(),
            unassigned_at: null,
          });
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(QueryFailedError);
      const pg = (caught as QueryFailedError).driverError as PgError;
      expect(pg.code).toBe('23505');

      // Cleanup any partial state from the failed TX (none should be
      // visible since the TX rolled back, but be safe).
      await withBypass(async (m) => {
        await m.query(`DELETE FROM group_mentors WHERE id IN ($1, $2)`, [
          firstId,
          secondId,
        ]);
      });
    });

    it('allows a new active row after the previous one is closed', async () => {
      const firstId = randomUUID();
      const secondId = randomUUID();

      await withBypass(async (m) => {
        await m.insert(GroupMentorEntity, {
          id: firstId,
          kindergarten_id: kgId,
          group_id: groupId,
          staff_member_id: staffA,
          is_primary: true,
          assigned_at: new Date(),
          unassigned_at: null,
        });
      });

      // Close the first row: now there is no active mentor for this group.
      await withBypass(async (m) => {
        await m.query(
          `UPDATE group_mentors SET unassigned_at = now() WHERE id = $1`,
          [firstId],
        );
      });

      // Inserting a second active row should now succeed.
      await withBypass(async (m) => {
        await m.insert(GroupMentorEntity, {
          id: secondId,
          kindergarten_id: kgId,
          group_id: groupId,
          staff_member_id: staffB,
          is_primary: true,
          assigned_at: new Date(),
          unassigned_at: null,
        });
      });

      const rows = await withBypass(async (m) => {
        return m.query(
          `SELECT id, unassigned_at FROM group_mentors WHERE id IN ($1, $2) ORDER BY assigned_at ASC`,
          [firstId, secondId],
        );
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].unassigned_at).not.toBeNull();
      expect(rows[1].unassigned_at).toBeNull();

      // Cleanup.
      await withBypass(async (m) => {
        await m.query(`DELETE FROM group_mentors WHERE id IN ($1, $2)`, [
          firstId,
          secondId,
        ]);
      });
    });
  },
);
