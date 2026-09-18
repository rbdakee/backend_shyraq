import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Camera } from '../../../../domain/entities/camera.entity';
import { CameraStreamKeyTakenError } from '../../../../domain/errors/camera-stream-key-taken.error';
import {
  CameraRepository,
  CreateCameraInput,
  ListCamerasFilters,
  UpdateCameraInput,
} from '../../camera.repository';
import { CameraEntity } from '../entities/camera.entity';
import { CameraMapper } from '../mappers/camera.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}
const PG_UNIQUE_VIOLATION = '23505';
const STREAM_KEY_CONSTRAINTS: Record<string, 'streamKey' | 'streamKeyHd'> = {
  uq_cameras_stream_key: 'streamKey',
  uq_cameras_stream_key_hd: 'streamKeyHd',
};

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
    const insertResult = await this.mapStreamKeyConflict(
      () =>
        repo.insert({
          kindergarten_id: kindergartenId,
          location_id: input.locationId,
          name: input.name,
          rtsp_url: input.rtspUrl,
          hls_url: input.hlsUrl ?? null,
          stream_key: input.streamKey ?? null,
          stream_key_hd: input.streamKeyHd ?? null,
          video_codec: null,
          codec_checked_at: null,
          is_active: true,
          archived_at: null,
        }),
      input,
    );
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

  async findByIdCrossTenant(id: string): Promise<Camera | null> {
    const ctx = tenantStorage.getStore();
    if (ctx?.entityManager) {
      const row = await ctx.entityManager
        .getRepository(CameraEntity)
        .findOne({ where: { id } });
      return row ? CameraMapper.toDomain(row) : null;
    }
    return this.repo.manager.transaction(async (tx) => {
      // TX-scoped: the GUC dies with the transaction, so it cannot leak into
      // a pooled connection's next request.
      await tx.query(`SET LOCAL app.bypass_rls = 'true'`);
      const row = await tx.getRepository(CameraEntity).findOne({
        where: { id },
      });
      return row ? CameraMapper.toDomain(row) : null;
    });
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

  async listStreamable(kindergartenId: string): Promise<Camera[]> {
    const rows = await this.manager()
      .getRepository(CameraEntity)
      .createQueryBuilder('c')
      .where('c.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('c.stream_key IS NOT NULL')
      .andWhere('c.archived_at IS NULL')
      .orderBy('c.created_at', 'ASC')
      .getMany();
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
    // Re-keying a camera drops what we knew about its codec — the key may now
    // point at a different physical camera. The domain entity applies the same
    // reset; this keeps the direct-patch path honest.
    if (patch.streamKey !== undefined) {
      data.stream_key = patch.streamKey;
      data.video_codec = null;
      data.codec_checked_at = null;
    }
    if (patch.streamKeyHd !== undefined) {
      data.stream_key_hd = patch.streamKeyHd;
    }
    if (Object.keys(data).length > 0) {
      const result = await this.mapStreamKeyConflict(
        () =>
          repo.update(
            { id, kindergarten_id: kindergartenId },
            data as Parameters<typeof repo.update>[1],
          ),
        patch,
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
    await this.mapStreamKeyConflict(
      () =>
        repo.update(
          { id: state.id, kindergarten_id: state.kindergartenId },
          {
            location_id: state.locationId,
            name: state.name,
            rtsp_url: state.rtspUrl,
            hls_url: state.hlsUrl,
            stream_key: state.streamKey,
            stream_key_hd: state.streamKeyHd,
            video_codec: state.videoCodec,
            codec_checked_at: state.codecCheckedAt,
            is_active: state.isActive,
            archived_at: state.archivedAt,
          },
        ),
      state,
    );
    const row = await repo.findOneOrFail({
      where: { id: state.id, kindergarten_id: state.kindergartenId },
    });
    return CameraMapper.toDomain(row);
  }

  /**
   * The stream-key indexes are unique across every tenant, so a collision can
   * be raised by a row RLS hides from this session — there is no way to
   * pre-check with a SELECT, and 23505 is the only signal we get. Translate it
   * into a domain error naming just the key.
   */
  private async mapStreamKeyConflict<T>(
    run: () => Promise<T>,
    keys: { streamKey?: string | null; streamKeyHd?: string | null },
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const pg = err as PgUniqueViolation | undefined;
      if (pg?.code === PG_UNIQUE_VIOLATION && pg.constraint) {
        const field = STREAM_KEY_CONSTRAINTS[pg.constraint];
        if (field) {
          throw new CameraStreamKeyTakenError(keys[field] ?? '<unknown>');
        }
      }
      throw err;
    }
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
