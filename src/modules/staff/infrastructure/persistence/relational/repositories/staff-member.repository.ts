import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { StaffMember } from '../../../../domain/entities/staff-member.entity';
import { StaffAlreadyExistsError } from '../../../../domain/errors/staff-already-exists.error';
import {
  CreateStaffMemberInput,
  StaffMemberRepository,
} from '../../../../staff-member.repository';
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
        role: input.role,
        specialist_type: input.specialistType ?? null,
        is_active: true,
        hired_at: input.hiredAt
          ? input.hiredAt.toISOString().slice(0, 10)
          : null,
        fired_at: null,
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

  async findById(id: string): Promise<StaffMember | null> {
    const row = await this.manager()
      .getRepository(StaffMemberEntity)
      .findOne({ where: { id } });
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

  async listByKindergarten(kindergartenId: string): Promise<StaffMember[]> {
    const rows = await this.manager()
      .getRepository(StaffMemberEntity)
      .find({
        where: { kindergarten_id: kindergartenId },
        order: { created_at: 'ASC' },
      });
    return rows.map((r) => StaffMemberMapper.toDomain(r));
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

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
