import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { StaffMember } from '../../../../domain/entities/staff-member.entity';
import { StaffAlreadyExistsError } from '../../../../domain/errors/staff-already-exists.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '../../staff-member.repository';
import { StaffMemberEntity } from '../entities/staff-member.entity';
import { StaffMemberMapper } from '../mappers/staff-member.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
  detail?: string;
}

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class StaffMemberRelationalRepository extends StaffMemberRepository {
  constructor(
    @InjectRepository(StaffMemberEntity)
    private readonly repo: Repository<StaffMemberEntity>,
  ) {
    super();
  }

  async create(input: CreateStaffMemberInput): Promise<StaffMember> {
    const repo = this.manager().getRepository(StaffMemberEntity);
    try {
      const insertResult = await repo.insert({
        kindergarten_id: input.kindergartenId,
        user_id: input.userId,
        full_name: input.fullName ?? null,
        phone: input.phone ?? null,
        role: input.role,
        specialist_type: input.specialistType ?? null,
        is_active: true,
        hired_at: input.hiredAt
          ? input.hiredAt.toISOString().slice(0, 10)
          : null,
        fired_at: null,
        archived_at: null,
      });
      const id = insertResult.identifiers[0].id as string;
      const created = await repo.findOneOrFail({ where: { id } });
      return StaffMemberMapper.toDomain(created);
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (pg?.code === PG_UNIQUE_VIOLATION) {
          throw new StaffAlreadyExistsError(input.kindergartenId, input.userId);
        }
      }
      throw err;
    }
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<StaffMember | null> {
    const row = await this.manager()
      .getRepository(StaffMemberEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? StaffMemberMapper.toDomain(row) : null;
  }

  async findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    const row = await this.manager()
      .getRepository(StaffMemberEntity)
      .findOne({
        where: {
          user_id: userId,
          kindergarten_id: kindergartenId,
          is_active: true,
        },
      });
    return row ? StaffMemberMapper.toDomain(row) : null;
  }

  async findByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    // Any-status lookup. Order by created_at DESC so the most recent
    // historical row wins when deactivate→reactivate cycles produced
    // several rows for the same pair.
    const row = await this.manager()
      .getRepository(StaffMemberEntity)
      .findOne({
        where: {
          user_id: userId,
          kindergarten_id: kindergartenId,
        },
        order: { created_at: 'DESC' },
      });
    return row ? StaffMemberMapper.toDomain(row) : null;
  }

  async listByKindergarten(
    kindergartenId: string,
    filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    const qb = this.manager()
      .getRepository(StaffMemberEntity)
      .createQueryBuilder('s')
      .where('s.kindergarten_id = :kg', { kg: kindergartenId });

    if (filters?.role !== undefined) {
      qb.andWhere('s.role = :role', { role: filters.role });
    }
    if (filters?.isActive !== undefined) {
      qb.andWhere('s.is_active = :ia', { ia: filters.isActive });
    }
    if (filters?.specialistType !== undefined) {
      qb.andWhere('s.specialist_type = :st', { st: filters.specialistType });
    }
    if (filters?.archived === true) {
      qb.andWhere('s.archived_at IS NOT NULL');
    } else if (filters?.archived === false) {
      qb.andWhere('s.archived_at IS NULL');
    }
    if (filters?.search) {
      qb.andWhere('(s.full_name ILIKE :q OR s.phone ILIKE :q)', {
        q: `%${filters.search}%`,
      });
    }

    qb.orderBy('s.created_at', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => StaffMemberMapper.toDomain(r));
  }

  async update(
    kindergartenId: string,
    id: string,
    changes: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    const repo = this.manager().getRepository(StaffMemberEntity);
    const data: Partial<StaffMemberEntity> = {};
    if (changes.fullName !== undefined) data.full_name = changes.fullName;
    if (changes.role !== undefined) data.role = changes.role;
    if (changes.specialistType !== undefined) {
      data.specialist_type = changes.specialistType;
    }
    if (changes.hiredAt !== undefined) {
      data.hired_at = changes.hiredAt
        ? changes.hiredAt.toISOString().slice(0, 10)
        : null;
    }
    if (changes.firedAt !== undefined) {
      data.fired_at = changes.firedAt
        ? changes.firedAt.toISOString().slice(0, 10)
        : null;
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
    return row ? StaffMemberMapper.toDomain(row) : null;
  }

  async save(staffMember: StaffMember): Promise<StaffMember> {
    const repo = this.manager().getRepository(StaffMemberEntity);
    const state = staffMember.toState();
    await repo.update(
      { id: state.id, kindergarten_id: state.kindergartenId },
      {
        full_name: state.fullName,
        phone: state.phone,
        role: state.role,
        specialist_type: state.specialistType,
        is_active: state.isActive,
        hired_at: state.hiredAt
          ? state.hiredAt.toISOString().slice(0, 10)
          : null,
        fired_at: state.firedAt
          ? state.firedAt.toISOString().slice(0, 10)
          : null,
        archived_at: state.archivedAt,
      },
    );
    const row = await repo.findOneOrFail({
      where: { id: state.id, kindergarten_id: state.kindergartenId },
    });
    return StaffMemberMapper.toDomain(row);
  }

  async deactivateAllByKindergarten(
    kindergartenId: string,
    now: Date,
  ): Promise<number> {
    const result = await this.manager()
      .getRepository(StaffMemberEntity)
      .createQueryBuilder()
      .update(StaffMemberEntity)
      .set({
        is_active: false,
        fired_at: now.toISOString().slice(0, 10),
        updated_at: now,
      })
      .where('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('is_active = true')
      .execute();
    return result.affected ?? 0;
  }

  async findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    // Cross-tenant — bypass RLS so no kindergarten GUC is needed.
    const rows = await this.repo.manager.transaction(async (tx) => {
      await tx.query(`SET LOCAL app.bypass_rls = 'true'`);
      return tx.getRepository(StaffMemberEntity).find({
        where: { user_id: userId, is_active: true },
        order: { created_at: 'ASC' },
      });
    });
    return rows.map((r) => StaffMemberMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
