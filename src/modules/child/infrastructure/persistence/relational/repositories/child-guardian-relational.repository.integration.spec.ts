/**
 * B6 child-guardian repository — cross-tenant pending-primary lookup.
 * Verifies that `findPendingPrimaryByUserIdCrossTenant` opens its own
 * bypass-RLS transaction and returns only `pending_approval` + `primary` rows
 * for the given user across tenants. Other roles/statuses are filtered out.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`.
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
import { ChildGuardianRelationalRepository } from './child-guardian.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'ChildGuardianRelationalRepository.findPendingPrimaryByUserIdCrossTenant',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let kgC: string;
    let userMain: string; // the user we filter by
    let userOther: string; // a different user, must be excluded
    let childA: string;
    let childB: string;
    let childC: string; // for approved row (negative case)
    let childD: string; // for secondary role (negative case)
    let childE: string; // for the `userOther` primary row (negative case)
    let pendingPrimaryA: string; // kg_A, primary, pending, userMain — included
    let pendingPrimaryB: string; // kg_B, primary, pending, userMain — included
    let approvedPrimaryC: string; // kg_C, primary, approved, userMain — excluded
    let pendingSecondaryD: string; // kg_A, secondary, pending, userMain — excluded
    let pendingPrimaryOther: string; // kg_A, primary, pending, userOther — excluded

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
        kgC = randomUUID();
        userMain = randomUUID();
        userOther = randomUUID();
        childA = randomUUID();
        childB = randomUUID();
        childC = randomUUID();
        childD = randomUUID();
        childE = randomUUID();
        pendingPrimaryA = randomUUID();
        pendingPrimaryB = randomUUID();
        approvedPrimaryC = randomUUID();
        pendingSecondaryD = randomUUID();
        pendingPrimaryOther = randomUUID();

        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-prim-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-prim-${kgB}` },
          { id: kgC, name: 'KG-C', slug: `kg-c-prim-${kgC}` },
        ]);
        await m.insert(UserEntity, [
          {
            id: userMain,
            phone: `+7700${userMain.slice(0, 7)}`,
            full_name: 'Main',
          },
          {
            id: userOther,
            phone: `+7711${userOther.slice(0, 7)}`,
            full_name: 'Other',
          },
        ]);
        const childRows = [
          [childA, kgA, 'A'],
          [childB, kgB, 'B'],
          [childC, kgC, 'C'],
          [childD, kgA, 'D'],
          [childE, kgA, 'E'],
        ] as const;
        await m.insert(
          ChildEntity,
          childRows.map(([id, kg, name]) => ({
            id,
            kindergarten_id: kg,
            iin: null,
            full_name: name,
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
          })),
        );
        await m.insert(ChildGuardianEntity, [
          {
            id: pendingPrimaryA,
            kindergarten_id: kgA,
            child_id: childA,
            user_id: userMain,
            role: 'primary',
            status: 'pending_approval',
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
            id: pendingPrimaryB,
            kindergarten_id: kgB,
            child_id: childB,
            user_id: userMain,
            role: 'primary',
            status: 'pending_approval',
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
            id: approvedPrimaryC,
            kindergarten_id: kgC,
            child_id: childC,
            user_id: userMain,
            role: 'primary',
            status: 'approved',
            has_approval_rights: true,
            approved_by: userMain,
            approved_at: new Date(),
            revoked_by: null,
            revoked_at: null,
            can_pickup: true,
            permissions: {},
            permissions_updated_by: null,
            permissions_updated_at: null,
          },
          {
            id: pendingSecondaryD,
            kindergarten_id: kgA,
            child_id: childD,
            user_id: userMain,
            role: 'secondary',
            status: 'pending_approval',
            has_approval_rights: false,
            approved_by: null,
            approved_at: null,
            revoked_by: null,
            revoked_at: null,
            can_pickup: false,
            permissions: {},
            permissions_updated_by: null,
            permissions_updated_at: null,
          },
          {
            id: pendingPrimaryOther,
            kindergarten_id: kgA,
            child_id: childE,
            user_id: userOther,
            role: 'primary',
            status: 'pending_approval',
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
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM child_guardians WHERE id IN ($1, $2, $3, $4, $5)`,
          [
            pendingPrimaryA,
            pendingPrimaryB,
            approvedPrimaryC,
            pendingSecondaryD,
            pendingPrimaryOther,
          ],
        );
        await m.query(`DELETE FROM children WHERE id IN ($1, $2, $3, $4, $5)`, [
          childA,
          childB,
          childC,
          childD,
          childE,
        ]);
        await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
          userMain,
          userOther,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2, $3)`, [
          kgA,
          kgB,
          kgC,
        ]);
      });
      await dataSource.destroy();
    });

    function makeRepo(): ChildGuardianRelationalRepository {
      return new ChildGuardianRelationalRepository(
        dataSource.getRepository(ChildGuardianEntity),
        dataSource,
      );
    }

    it('returns pending-primary rows across tenants', async () => {
      const repo = makeRepo();
      const rows = await repo.findPendingPrimaryByUserIdCrossTenant(userMain);
      const ids = rows.map((g) => g.id);
      expect(ids).toEqual(
        expect.arrayContaining([pendingPrimaryA, pendingPrimaryB]),
      );
      expect(ids).toHaveLength(2);
      const kgs = new Set(rows.map((g) => g.kindergartenId as string));
      expect(kgs.has(kgA)).toBe(true);
      expect(kgs.has(kgB)).toBe(true);
    });

    it('does not return approved or rejected rows', async () => {
      const repo = makeRepo();
      const rows = await repo.findPendingPrimaryByUserIdCrossTenant(userMain);
      const ids = rows.map((g) => g.id);
      expect(ids).not.toContain(approvedPrimaryC);
      expect(rows.every((g) => g.status.value === 'pending_approval')).toBe(
        true,
      );
    });

    it('does not return rows with role != primary', async () => {
      const repo = makeRepo();
      const rows = await repo.findPendingPrimaryByUserIdCrossTenant(userMain);
      const ids = rows.map((g) => g.id);
      expect(ids).not.toContain(pendingSecondaryD);
      expect(rows.every((g) => g.role.value === 'primary')).toBe(true);
    });

    it('does not leak rows for other users', async () => {
      const repo = makeRepo();
      const rows = await repo.findPendingPrimaryByUserIdCrossTenant(userMain);
      const ids = rows.map((g) => g.id);
      expect(ids).not.toContain(pendingPrimaryOther);
    });
  },
);
