import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { KindergartenHoliday } from '../../../../domain/entities/kindergarten-holiday.entity';
import { KindergartenHolidayAlreadyExistsError } from '../../../../domain/errors/kindergarten-holiday-already-exists.error';
import {
  CreateKindergartenHolidayInput,
  KindergartenHolidayRepository,
  ListKindergartenHolidaysFilter,
  UpdateKindergartenHolidayPatch,
} from '../../kindergarten-holiday.repository';
import { KindergartenHolidayTypeOrmEntity } from '../entities/kindergarten-holiday.typeorm.entity';
import { KindergartenHolidayMapper } from '../mappers/kindergarten-holiday.mapper';
import { toIsoDate } from '../mappers/date-utils';

interface PgError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown): err is QueryFailedError {
  if (!(err instanceof QueryFailedError)) return false;
  return (err.driverError as PgError)?.code === '23505';
}

@Injectable()
export class KindergartenHolidayRelationalRepository extends KindergartenHolidayRepository {
  constructor(
    @InjectRepository(KindergartenHolidayTypeOrmEntity)
    private readonly repo: Repository<KindergartenHolidayTypeOrmEntity>,
  ) {
    super();
  }

  private manager(): EntityManager {
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async create(
    input: CreateKindergartenHolidayInput,
  ): Promise<KindergartenHoliday> {
    const m = this.manager().getRepository(KindergartenHolidayTypeOrmEntity);
    try {
      const inserted = m.create({
        kindergartenId: input.kindergartenId,
        date: toIsoDate(input.date),
        name: input.name,
        isBillable: input.isBillable,
      });
      const saved = await m.save(inserted);
      return KindergartenHolidayMapper.toDomain(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new KindergartenHolidayAlreadyExistsError(
          input.kindergartenId,
          toIsoDate(input.date),
        );
      }
      throw err;
    }
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateKindergartenHolidayPatch,
    now: Date,
  ): Promise<KindergartenHoliday | null> {
    const m = this.manager().getRepository(KindergartenHolidayTypeOrmEntity);
    const setPayload: Partial<KindergartenHolidayTypeOrmEntity> = {
      updatedAt: now,
    };
    if (patch.date !== undefined) setPayload.date = toIsoDate(patch.date);
    if (patch.name !== undefined) setPayload.name = patch.name;
    if (patch.isBillable !== undefined) {
      setPayload.isBillable = patch.isBillable;
    }
    try {
      const result = await m.update({ id, kindergartenId }, setPayload);
      if (!result.affected) return null;
      const row = await m.findOne({ where: { id, kindergartenId } });
      return row ? KindergartenHolidayMapper.toDomain(row) : null;
    } catch (err) {
      if (isUniqueViolation(err) && patch.date !== undefined) {
        throw new KindergartenHolidayAlreadyExistsError(
          kindergartenId,
          toIsoDate(patch.date),
        );
      }
      throw err;
    }
  }

  async delete(kindergartenId: string, id: string): Promise<void> {
    await this.manager()
      .getRepository(KindergartenHolidayTypeOrmEntity)
      .delete({ id, kindergartenId });
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<KindergartenHoliday | null> {
    const row = await this.manager()
      .getRepository(KindergartenHolidayTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? KindergartenHolidayMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListKindergartenHolidaysFilter = {},
  ): Promise<KindergartenHoliday[]> {
    const qb = this.manager()
      .getRepository(KindergartenHolidayTypeOrmEntity)
      .createQueryBuilder('h')
      .where('h.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.fromDate) {
      qb.andWhere('h.date >= :f', { f: filter.fromDate });
    }
    if (filter.toDate) {
      qb.andWhere('h.date <= :t', { t: filter.toDate });
    }
    if (filter.isBillable !== undefined) {
      qb.andWhere('h.is_billable = :b', { b: filter.isBillable });
    }

    qb.orderBy('h.date', 'ASC');
    const rows = await qb.getMany();
    return rows.map(KindergartenHolidayMapper.toDomain);
  }

  async countNonBillableInRange(
    kindergartenId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    return this.manager()
      .getRepository(KindergartenHolidayTypeOrmEntity)
      .createQueryBuilder('h')
      .where('h.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('h.is_billable = false')
      .andWhere('h.date >= :f', { f: toIsoDate(periodStart) })
      .andWhere('h.date <= :t', { t: toIsoDate(periodEnd) })
      .getCount();
  }
}
