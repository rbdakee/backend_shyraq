import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Group } from '../../../../domain/entities/group.entity';
import { GroupMentor } from '../../../../domain/entities/group-mentor.entity';
import { MentorAlreadyActiveError } from '../../../../domain/errors/mentor-already-active.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '../../group.repository';
import { GroupEntity } from '../entities/group.entity';
import { GroupMentorEntity } from '../entities/group-mentor.entity';
import { GroupMapper } from '../mappers/group.mapper';
import { GroupMentorMapper } from '../mappers/group-mentor.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class GroupRelationalRepository extends GroupRepository {
  constructor(
    @InjectRepository(GroupEntity)
    private readonly repo: Repository<GroupEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    input: CreateGroupInput,
  ): Promise<Group> {
    const repo = this.manager().getRepository(GroupEntity);
    const insertResult = await repo.insert({
      kindergarten_id: kindergartenId,
      name: input.name,
      capacity: input.capacity,
      age_range_min: input.ageRangeMin ?? null,
      age_range_max: input.ageRangeMax ?? null,
      current_location_id: input.currentLocationId ?? null,
      archived_at: null,
    });
    const id = insertResult.identifiers[0].id as string;
    const created = await repo.findOneOrFail({
      where: { id, kindergarten_id: kindergartenId },
    });
    return GroupMapper.toDomain(created);
  }

  async findById(kindergartenId: string, id: string): Promise<Group | null> {
    const row = await this.manager()
      .getRepository(GroupEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? GroupMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filters?: ListGroupsFilters,
  ): Promise<Group[]> {
    const qb = this.manager()
      .getRepository(GroupEntity)
      .createQueryBuilder('g')
      .where('g.kindergarten_id = :kg', { kg: kindergartenId });
    if (filters?.archived === true) {
      qb.andWhere('g.archived_at IS NOT NULL');
    } else if (filters?.archived === false) {
      qb.andWhere('g.archived_at IS NULL');
    }
    qb.orderBy('g.created_at', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => GroupMapper.toDomain(r));
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateGroupInput,
  ): Promise<Group | null> {
    const repo = this.manager().getRepository(GroupEntity);
    const data: Partial<GroupEntity> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.capacity !== undefined) data.capacity = patch.capacity;
    if (patch.ageRangeMin !== undefined) data.age_range_min = patch.ageRangeMin;
    if (patch.ageRangeMax !== undefined) data.age_range_max = patch.ageRangeMax;
    if (patch.currentLocationId !== undefined) {
      data.current_location_id = patch.currentLocationId;
    }
    if (Object.keys(data).length > 0) {
      const result = await repo.update(
        { id, kindergarten_id: kindergartenId },
        data as Parameters<typeof repo.update>[1],
      );
      if (result.affected === 0) return null;
    }
    const row = await repo.findOne({
      where: { id, kindergarten_id: kindergartenId },
    });
    return row ? GroupMapper.toDomain(row) : null;
  }

  async save(group: Group): Promise<Group> {
    const repo = this.manager().getRepository(GroupEntity);
    const state = group.toState();
    await repo.update(
      { id: state.id, kindergarten_id: state.kindergartenId },
      {
        name: state.name,
        capacity: state.capacity,
        age_range_min: state.ageRangeMin,
        age_range_max: state.ageRangeMax,
        current_location_id: state.currentLocationId,
        archived_at: state.archivedAt,
      },
    );
    const row = await repo.findOneOrFail({
      where: { id: state.id, kindergarten_id: state.kindergartenId },
    });
    return GroupMapper.toDomain(row);
  }

  // ── group_mentors ──────────────────────────────────────────────────────

  async assignMentor(
    kindergartenId: string,
    groupId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<GroupMentor> {
    const manager = this.manager();
    const mentorRepo = manager.getRepository(GroupMentorEntity);

    // Close any currently-active row for this group inside the same TX so
    // the partial-unique idx_group_mentors_one_active stays satisfied when
    // we insert the new row a moment later.
    await mentorRepo
      .createQueryBuilder()
      .update(GroupMentorEntity)
      .set({ unassigned_at: now })
      .where('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('group_id = :g', { g: groupId })
      .andWhere('unassigned_at IS NULL')
      .execute();

    try {
      const insertResult = await mentorRepo.insert({
        kindergarten_id: kindergartenId,
        group_id: groupId,
        staff_member_id: staffMemberId,
        is_primary: true,
        assigned_at: now,
        unassigned_at: null,
      });
      const id = insertResult.identifiers[0].id as string;
      const created = await mentorRepo.findOneOrFail({ where: { id } });
      return GroupMentorMapper.toDomain(created);
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (pg?.code === PG_UNIQUE_VIOLATION) {
          throw new MentorAlreadyActiveError(groupId);
        }
      }
      throw err;
    }
  }

  async unassignMentor(
    kindergartenId: string,
    groupId: string,
    now: Date,
  ): Promise<GroupMentor | null> {
    const manager = this.manager();
    const mentorRepo = manager.getRepository(GroupMentorEntity);
    // Need explicit IS NULL — TypeORM .findOne does not handle that cleanly.
    const activeRow = await mentorRepo
      .createQueryBuilder('m')
      .where('m.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('m.group_id = :g', { g: groupId })
      .andWhere('m.unassigned_at IS NULL')
      .getOne();
    if (!activeRow) return null;
    await mentorRepo.update({ id: activeRow.id }, { unassigned_at: now });
    const fresh = await mentorRepo.findOneOrFail({
      where: { id: activeRow.id },
    });
    return GroupMentorMapper.toDomain(fresh);
  }

  async unassignMentorByStaffMember(
    kindergartenId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<number> {
    // Cascade triggered by Staff lifecycle (deactivate / archive). One staff
    // member may simultaneously be the active mentor of MULTIPLE groups —
    // there is no DB constraint forbidding that, the partial-unique index
    // is keyed on `group_id`. Close every active row in the kg, idempotent.
    const result = await this.manager()
      .getRepository(GroupMentorEntity)
      .createQueryBuilder()
      .update(GroupMentorEntity)
      .set({ unassigned_at: now })
      .where('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('staff_member_id = :sid', { sid: staffMemberId })
      .andWhere('unassigned_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  async findActiveMentor(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor | null> {
    const row = await this.manager()
      .getRepository(GroupMentorEntity)
      .createQueryBuilder('m')
      .where('m.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('m.group_id = :g', { g: groupId })
      .andWhere('m.unassigned_at IS NULL')
      .getOne();
    return row ? GroupMentorMapper.toDomain(row) : null;
  }

  async listMentorHistory(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor[]> {
    const rows = await this.manager()
      .getRepository(GroupMentorEntity)
      .createQueryBuilder('m')
      .where('m.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('m.group_id = :g', { g: groupId })
      .orderBy('m.assigned_at', 'DESC')
      .getMany();
    return rows.map((r) => GroupMentorMapper.toDomain(r));
  }

  async findActiveMentorAssignmentsByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<GroupMentor[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const qb = manager
        .getRepository(GroupMentorEntity)
        .createQueryBuilder('m')
        .innerJoin(
          'staff_members',
          's',
          's.id = m.staff_member_id AND s.user_id = :uid',
          { uid: userId },
        )
        .where('m.unassigned_at IS NULL');
      // WS auto-subscribe passes the JWT's kindergarten_id so a user
      // who staffs multiple kgs only joins group:* rooms for the kg
      // their current handshake is scoped to.
      if (kindergartenId) {
        qb.andWhere('m.kindergarten_id = :kg', { kg: kindergartenId });
      }
      const rows = await qb.orderBy('m.assigned_at', 'ASC').getMany();
      return rows.map((r) => GroupMentorMapper.toDomain(r));
    });
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
