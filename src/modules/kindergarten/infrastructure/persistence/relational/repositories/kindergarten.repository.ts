import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Kindergarten } from '../../../../domain/entities/kindergarten.entity';
import { KindergartenNotFoundError } from '../../../../domain/errors/kindergarten-not-found.error';
import { KindergartenSlugTakenError } from '../../../../domain/errors/kindergarten-slug-taken.error';
import {
  KindergartenCreateInput,
  KindergartenFilters,
  KindergartenListResult,
  KindergartenRepository,
  KindergartenUpdateInput,
} from '../../kindergarten.repository';
import { KindergartenEntity } from '../entities/kindergarten.entity';
import { KindergartenMapper } from '../mappers/kindergarten.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
  detail?: string;
}

const PG_UNIQUE_VIOLATION = '23505';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class KindergartenRelationalRepository extends KindergartenRepository {
  constructor(
    @InjectRepository(KindergartenEntity)
    private readonly repo: Repository<KindergartenEntity>,
  ) {
    super();
  }

  async create(input: KindergartenCreateInput): Promise<Kindergarten> {
    const repo = this.manager().getRepository(KindergartenEntity);
    try {
      // The jsonb column makes TypeORM's QueryDeepPartialEntity unusable for
      // an inline literal — flatten via `as unknown` so the call type-checks
      // without forcing every callsite to wrap settings in a class.
      const insertPayload = {
        name: input.name,
        slug: input.slug,
        address: input.address,
        phone: input.phone,
        plan: input.plan,
        settings: input.settings,
        is_active: true,
        archived_at: null,
      } as unknown as Parameters<typeof repo.insert>[0];
      const insertResult = await repo.insert(insertPayload);
      const id = insertResult.identifiers[0].id as string;
      const created = await repo.findOneOrFail({ where: { id } });
      return KindergartenMapper.toDomain(created);
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (pg?.code === PG_UNIQUE_VIOLATION) {
          throw new KindergartenSlugTakenError(input.slug);
        }
      }
      throw err;
    }
  }

  async findById(id: string): Promise<Kindergarten | null> {
    const row = await this.manager()
      .getRepository(KindergartenEntity)
      .findOne({ where: { id } });
    return row ? KindergartenMapper.toDomain(row) : null;
  }

  async findBySlug(slug: string): Promise<Kindergarten | null> {
    const row = await this.manager()
      .getRepository(KindergartenEntity)
      .findOne({ where: { slug } });
    return row ? KindergartenMapper.toDomain(row) : null;
  }

  async findAll(filters: KindergartenFilters): Promise<KindergartenListResult> {
    const repo = this.manager().getRepository(KindergartenEntity);
    const qb = repo.createQueryBuilder('kg');
    if (filters.plan) {
      qb.andWhere('kg.plan = :plan', { plan: filters.plan });
    }
    if (filters.isActive !== undefined) {
      qb.andWhere('kg.is_active = :ia', { ia: filters.isActive });
    }
    if (filters.archived === true) {
      qb.andWhere('kg.archived_at IS NOT NULL');
    } else if (filters.archived === false) {
      qb.andWhere('kg.archived_at IS NULL');
    }
    if (filters.nameSearch) {
      qb.andWhere('kg.name ILIKE :ns', { ns: `%${filters.nameSearch}%` });
    }
    const limit = clampLimit(filters.limit);
    const offset = Math.max(0, filters.offset ?? 0);
    qb.orderBy('kg.created_at', 'DESC').skip(offset).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => KindergartenMapper.toDomain(r)),
      total,
      limit,
      offset,
    };
  }

  async listActive(): Promise<Kindergarten[]> {
    const repo = this.manager().getRepository(KindergartenEntity);
    const rows = await repo
      .createQueryBuilder('kg')
      .where('kg.is_active = TRUE')
      .andWhere('kg.archived_at IS NULL')
      .orderBy('kg.created_at', 'ASC')
      .getMany();
    return rows.map((r) => KindergartenMapper.toDomain(r));
  }

  async update(
    id: string,
    changes: KindergartenUpdateInput,
  ): Promise<Kindergarten> {
    const repo = this.manager().getRepository(KindergartenEntity);
    const data: Partial<KindergartenEntity> = {};
    if (changes.name !== undefined) data.name = changes.name;
    if (changes.address !== undefined) data.address = changes.address;
    if (changes.phone !== undefined) data.phone = changes.phone;
    if (changes.plan !== undefined) data.plan = changes.plan;
    if (changes.settings !== undefined) {
      data.settings = changes.settings as KindergartenEntity['settings'];
    }
    if (changes.isActive !== undefined) data.is_active = changes.isActive;
    if (changes.archivedAt !== undefined) data.archived_at = changes.archivedAt;

    if (Object.keys(data).length === 0) {
      const existing = await repo.findOne({ where: { id } });
      if (!existing) throw new KindergartenNotFoundError(id);
      return KindergartenMapper.toDomain(existing);
    }

    const result = await repo.update(
      { id },
      data as Parameters<typeof repo.update>[1],
    );
    if (result.affected === 0) {
      throw new KindergartenNotFoundError(id);
    }
    const row = await repo.findOneOrFail({ where: { id } });
    return KindergartenMapper.toDomain(row);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}

function clampLimit(input: number | undefined): number {
  if (input === undefined || input <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(input));
}
