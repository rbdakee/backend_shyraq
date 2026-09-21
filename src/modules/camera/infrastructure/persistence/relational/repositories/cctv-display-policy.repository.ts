import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { CctvDisplayPolicy } from '../../../../domain/entities/cctv-display-policy.entity';
import {
  CctvDisplayPolicyRepository,
  SaveCctvDisplayPolicyInput,
} from '../../cctv-display-policy.repository';
import { CctvDisplayPolicyEntity } from '../entities/cctv-display-policy.entity';
import { CctvDisplayPolicyMapper } from '../mappers/cctv-display-policy.mapper';

@Injectable()
export class CctvDisplayPolicyRelationalRepository extends CctvDisplayPolicyRepository {
  constructor(
    @InjectRepository(CctvDisplayPolicyEntity)
    private readonly repo: Repository<CctvDisplayPolicyEntity>,
  ) {
    super();
  }

  async findByKindergarten(
    kindergartenId: string,
  ): Promise<CctvDisplayPolicy | null> {
    const row = await this.manager()
      .getRepository(CctvDisplayPolicyEntity)
      .findOne({ where: { kindergarten_id: kindergartenId } });
    return row ? CctvDisplayPolicyMapper.toDomain(row) : null;
  }

  /**
   * One statement, not read-then-write: the admin screen saves the whole
   * policy, and `ON CONFLICT (kindergarten_id)` makes the first save and every
   * later one the same code path without a race between two open tabs.
   */
  async upsert(
    kindergartenId: string,
    input: SaveCctvDisplayPolicyInput,
  ): Promise<CctvDisplayPolicy> {
    const repo = this.manager().getRepository(CctvDisplayPolicyEntity);
    await repo
      .createQueryBuilder()
      .insert()
      .into(CctvDisplayPolicyEntity)
      .values({
        kindergarten_id: kindergartenId,
        work_days: input.workDays,
        opens_at: input.opensAt,
        closes_at: input.closesAt,
        work_hours_mode: input.workHours.mode,
        work_hours_camera_ids: input.workHours.cameraIds,
        off_hours_mode: input.offHours.mode,
        off_hours_camera_ids: input.offHours.cameraIds,
      })
      .orUpdate(
        [
          'work_days',
          'opens_at',
          'closes_at',
          'work_hours_mode',
          'work_hours_camera_ids',
          'off_hours_mode',
          'off_hours_camera_ids',
          'updated_at',
        ],
        ['kindergarten_id'],
      )
      .execute();

    const row = await repo.findOneOrFail({
      where: { kindergarten_id: kindergartenId },
    });
    return CctvDisplayPolicyMapper.toDomain(row);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
