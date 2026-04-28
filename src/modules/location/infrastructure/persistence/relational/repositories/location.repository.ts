import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Location } from '../../../../domain/entities/location.entity';
import {
  CreateLocationInput,
  ListLocationsFilters,
  LocationRepository,
  UpdateLocationInput,
} from '../../../../location.repository';
import { LocationEntity } from '../entities/location.entity';
import { LocationMapper } from '../mappers/location.mapper';

@Injectable()
export class LocationRelationalRepository extends LocationRepository {
  constructor(
    @InjectRepository(LocationEntity)
    private readonly repo: Repository<LocationEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    input: CreateLocationInput,
  ): Promise<Location> {
    const repo = this.manager().getRepository(LocationEntity);
    const insertResult = await repo.insert({
      kindergarten_id: kindergartenId,
      name: input.name,
      description: input.description ?? null,
      archived_at: null,
    });
    const id = insertResult.identifiers[0].id as string;
    const created = await repo.findOneOrFail({
      where: { id, kindergarten_id: kindergartenId },
    });
    return LocationMapper.toDomain(created);
  }

  async findById(kindergartenId: string, id: string): Promise<Location | null> {
    const row = await this.manager()
      .getRepository(LocationEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? LocationMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filters?: ListLocationsFilters,
  ): Promise<Location[]> {
    const qb = this.manager()
      .getRepository(LocationEntity)
      .createQueryBuilder('l')
      .where('l.kindergarten_id = :kg', { kg: kindergartenId });
    if (filters?.archived === true) {
      qb.andWhere('l.archived_at IS NOT NULL');
    } else if (filters?.archived === false) {
      qb.andWhere('l.archived_at IS NULL');
    }
    qb.orderBy('l.created_at', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => LocationMapper.toDomain(r));
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateLocationInput,
  ): Promise<Location | null> {
    const repo = this.manager().getRepository(LocationEntity);
    const data: Partial<LocationEntity> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.description !== undefined) data.description = patch.description;
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
    return row ? LocationMapper.toDomain(row) : null;
  }

  async save(location: Location): Promise<Location> {
    const repo = this.manager().getRepository(LocationEntity);
    const state = location.toState();
    await repo.update(
      { id: state.id, kindergarten_id: state.kindergartenId },
      {
        name: state.name,
        description: state.description,
        archived_at: state.archivedAt,
      },
    );
    const row = await repo.findOneOrFail({
      where: { id: state.id, kindergarten_id: state.kindergartenId },
    });
    return LocationMapper.toDomain(row);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
