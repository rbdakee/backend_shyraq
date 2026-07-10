import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { SpecialistType } from '../../../../domain/entities/specialist-type.entity';
import { SpecialistTypeCodeTakenError } from '../../../../domain/errors/specialist-type-code-taken.error';
import { SYSTEM_SPECIALIST_TYPES } from '../../../../domain/system-defaults';
import {
  ListSpecialistTypesFilter,
  SpecialistTypeRepository,
  SpecialistTypeUsage,
} from '../../specialist-type.repository';
import { SpecialistTypeEntity } from '../entities/specialist-type.entity';
import { SpecialistTypeMapper } from '../mappers/specialist-type.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class SpecialistTypeRelationalRepository extends SpecialistTypeRepository {
  constructor(
    @InjectRepository(SpecialistTypeEntity)
    private readonly repo: Repository<SpecialistTypeEntity>,
  ) {
    super();
  }

  async create(entity: SpecialistType): Promise<SpecialistType> {
    const repo = this.manager().getRepository(SpecialistTypeEntity);
    const s = entity.toState();
    try {
      const payload = {
        id: s.id,
        kindergarten_id: s.kindergartenId,
        code: s.code,
        name_i18n: s.nameI18n,
        is_system: s.isSystem,
        is_active: s.isActive,
        sort_order: s.sortOrder,
      } as unknown as Parameters<typeof repo.insert>[0];
      await repo.insert(payload);
      const created = await repo.findOneOrFail({ where: { id: s.id } });
      return SpecialistTypeMapper.toDomain(created);
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (pg?.code === PG_UNIQUE_VIOLATION) {
          throw new SpecialistTypeCodeTakenError(s.code);
        }
      }
      throw err;
    }
  }

  async save(entity: SpecialistType): Promise<SpecialistType> {
    const repo = this.manager().getRepository(SpecialistTypeEntity);
    const s = entity.toState();
    await repo.update({ id: s.id, kindergarten_id: s.kindergartenId }, {
      name_i18n: s.nameI18n,
      is_active: s.isActive,
      sort_order: s.sortOrder,
      updated_at: s.updatedAt,
    } as unknown as Parameters<typeof repo.update>[1]);
    const row = await repo.findOneOrFail({ where: { id: s.id } });
    return SpecialistTypeMapper.toDomain(row);
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<SpecialistType | null> {
    const row = await this.manager()
      .getRepository(SpecialistTypeEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? SpecialistTypeMapper.toDomain(row) : null;
  }

  async findByCode(
    kindergartenId: string,
    code: string,
  ): Promise<SpecialistType | null> {
    const row = await this.manager()
      .getRepository(SpecialistTypeEntity)
      .findOne({ where: { code, kindergarten_id: kindergartenId } });
    return row ? SpecialistTypeMapper.toDomain(row) : null;
  }

  async existsActiveByCode(
    kindergartenId: string,
    code: string,
  ): Promise<boolean> {
    const count = await this.manager()
      .getRepository(SpecialistTypeEntity)
      .count({
        where: { code, kindergarten_id: kindergartenId, is_active: true },
      });
    return count > 0;
  }

  async list(
    kindergartenId: string,
    filter?: ListSpecialistTypesFilter,
  ): Promise<SpecialistType[]> {
    const qb = this.manager()
      .getRepository(SpecialistTypeEntity)
      .createQueryBuilder('st')
      .where('st.kindergarten_id = :kg', { kg: kindergartenId });
    if (!filter?.includeInactive) {
      qb.andWhere('st.is_active = TRUE');
    }
    qb.orderBy('st.sort_order', 'ASC').addOrderBy('st.code', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => SpecialistTypeMapper.toDomain(r));
  }

  async delete(kindergartenId: string, id: string): Promise<boolean> {
    const result = await this.manager()
      .getRepository(SpecialistTypeEntity)
      .delete({ id, kindergarten_id: kindergartenId });
    return (result.affected ?? 0) > 0;
  }

  async countUsage(
    kindergartenId: string,
    code: string,
  ): Promise<SpecialistTypeUsage> {
    const em = this.manager();
    const staffRows = (await em.query(
      `SELECT COUNT(*)::int AS c FROM "staff_members"
        WHERE "kindergarten_id" = $1 AND "specialist_type" = $2`,
      [kindergartenId, code],
    )) as Array<{ c: number }>;
    const templateRows = (await em.query(
      `SELECT COUNT(*)::int AS c FROM "diagnostic_templates"
        WHERE "kindergarten_id" = $1 AND "specialist_type" = $2`,
      [kindergartenId, code],
    )) as Array<{ c: number }>;
    return {
      staffMembers: staffRows[0]?.c ?? 0,
      diagnosticTemplates: templateRows[0]?.c ?? 0,
    };
  }

  async seedSystemDefaults(kindergartenId: string): Promise<void> {
    const em = this.manager();
    // Idempotent bulk insert — ON CONFLICT keeps existing (possibly renamed)
    // rows untouched. One parameterised VALUES tuple per system code.
    const values: string[] = [];
    const params: unknown[] = [kindergartenId];
    let p = 2;
    SYSTEM_SPECIALIST_TYPES.forEach((seed, index) => {
      values.push(`($1, $${p}, $${p + 1}::jsonb, TRUE, TRUE, $${p + 2})`);
      params.push(seed.code, JSON.stringify(seed.nameI18n), index);
      p += 3;
    });
    await em.query(
      `INSERT INTO "specialist_types"
         ("kindergarten_id", "code", "name_i18n", "is_system", "is_active", "sort_order")
       VALUES ${values.join(', ')}
       ON CONFLICT ("kindergarten_id", "code") DO NOTHING`,
      params,
    );
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
