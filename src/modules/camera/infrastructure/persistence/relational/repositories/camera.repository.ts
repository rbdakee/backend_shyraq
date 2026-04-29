import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Camera } from '../../../../domain/entities/camera.entity';
import {
  CameraRepository,
  CreateCameraInput,
  ListCamerasFilters,
  UpdateCameraInput,
} from '../../camera.repository';
import { CameraEntity } from '../entities/camera.entity';
import { CameraMapper } from '../mappers/camera.mapper';

@Injectable()
export class CameraRelationalRepository extends CameraRepository {
  constructor(
    @InjectRepository(CameraEntity)
    private readonly repo: Repository<CameraEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    input: CreateCameraInput,
  ): Promise<Camera> {
    const repo = this.manager().getRepository(CameraEntity);
    const insertResult = await repo.insert({
      kindergarten_id: kindergartenId,
      location_id: input.locationId,
      name: input.name,
      rtsp_url: input.rtspUrl,
      hls_url: input.hlsUrl ?? null,
      is_active: true,
      archived_at: null,
    });
    const id = insertResult.identifiers[0].id as string;
    const created = await repo.findOneOrFail({
      where: { id, kindergarten_id: kindergartenId },
    });
    return CameraMapper.toDomain(created);
  }

  async findById(kindergartenId: string, id: string): Promise<Camera | null> {
    const row = await this.manager()
      .getRepository(CameraEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? CameraMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filters?: ListCamerasFilters,
  ): Promise<Camera[]> {
    const qb = this.manager()
      .getRepository(CameraEntity)
      .createQueryBuilder('c')
      .where('c.kindergarten_id = :kg', { kg: kindergartenId });
    if (filters?.locationId) {
      qb.andWhere('c.location_id = :loc', { loc: filters.locationId });
    }
    if (filters?.archived === true) {
      qb.andWhere('c.archived_at IS NOT NULL');
    } else if (filters?.archived === false) {
      qb.andWhere('c.archived_at IS NULL');
    }
    qb.orderBy('c.created_at', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => CameraMapper.toDomain(r));
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateCameraInput,
  ): Promise<Camera | null> {
    const repo = this.manager().getRepository(CameraEntity);
    const data: Partial<CameraEntity> = {};
    if (patch.locationId !== undefined) data.location_id = patch.locationId;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.rtspUrl !== undefined) data.rtsp_url = patch.rtspUrl;
    if (patch.hlsUrl !== undefined) data.hls_url = patch.hlsUrl;
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
    return row ? CameraMapper.toDomain(row) : null;
  }

  async save(camera: Camera): Promise<Camera> {
    const repo = this.manager().getRepository(CameraEntity);
    const state = camera.toState();
    await repo.update(
      { id: state.id, kindergarten_id: state.kindergartenId },
      {
        location_id: state.locationId,
        name: state.name,
        rtsp_url: state.rtspUrl,
        hls_url: state.hlsUrl,
        is_active: state.isActive,
        archived_at: state.archivedAt,
      },
    );
    const row = await repo.findOneOrFail({
      where: { id: state.id, kindergarten_id: state.kindergartenId },
    });
    return CameraMapper.toDomain(row);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
