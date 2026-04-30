/**
 * B6 child repository — cross-tenant IIN lookup. Verifies that
 * `findByIinCrossTenant` opens its own bypass-RLS transaction and returns
 * matching children from any tenant, while skipping archived rows.
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
import { ChildRelationalRepository } from './child.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('ChildRelationalRepository.findByIinCrossTenant', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgA: string;
  let kgB: string;
  let childA: string; // kg_A, IIN=sharedIin, status=card_created
  let childB: string; // kg_B, IIN=sharedIin, status=active
  let childArchived: string; // kg_A, IIN=archivedIin, status=archived
  const sharedIin = '001122334455';
  const archivedIin = '997788776655';

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
      childA = randomUUID();
      childB = randomUUID();
      childArchived = randomUUID();

      await m.insert(KindergartenEntity, [
        { id: kgA, name: 'KG-A', slug: `kg-a-iinx-${kgA}` },
        { id: kgB, name: 'KG-B', slug: `kg-b-iinx-${kgB}` },
      ]);
      await m.insert(ChildEntity, [
        {
          id: childA,
          kindergarten_id: kgA,
          iin: sharedIin,
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
          iin: sharedIin,
          full_name: 'Aigerim B',
          date_of_birth: '2021-09-15',
          gender: 'f',
          photo_url: null,
          status: 'active',
          current_group_id: null,
          enrollment_date: '2026-01-01',
          archived_at: null,
          archive_reason: null,
          medical_notes: null,
          allergy_notes: null,
        },
        {
          id: childArchived,
          kindergarten_id: kgA,
          iin: archivedIin,
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
      await m.query(`DELETE FROM children WHERE id IN ($1, $2, $3)`, [
        childA,
        childB,
        childArchived,
      ]);
      await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
        kgA,
        kgB,
      ]);
    });
    await dataSource.destroy();
  });

  function makeRepo(): ChildRelationalRepository {
    return new ChildRelationalRepository(
      dataSource.getRepository(ChildEntity),
      dataSource,
    );
  }

  it('returns rows from multiple tenants when iin matches', async () => {
    const repo = makeRepo();
    const rows = await repo.findByIinCrossTenant(sharedIin);
    const ids = rows.map((c) => c.id as string);
    expect(ids).toEqual(expect.arrayContaining([childA, childB]));
    expect(ids).toHaveLength(2);
    const kgs = new Set(rows.map((c) => c.kindergartenId as string));
    expect(kgs.has(kgA)).toBe(true);
    expect(kgs.has(kgB)).toBe(true);
  });

  it('returns empty array when iin not found', async () => {
    const repo = makeRepo();
    const rows = await repo.findByIinCrossTenant('123456789012');
    expect(rows).toEqual([]);
  });

  it('skips archived children', async () => {
    const repo = makeRepo();
    const rows = await repo.findByIinCrossTenant(archivedIin);
    expect(rows).toEqual([]);
  });
});
