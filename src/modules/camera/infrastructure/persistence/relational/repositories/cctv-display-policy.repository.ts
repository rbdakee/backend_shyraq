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
        common_camera_ids: input.commonCameraIds,
        hide_rules: input.hideRules.map((rule) =>
          CctvDisplayPolicyMapper.ruleToRow(rule),
        ),
      })
      .orUpdate(
        ['common_camera_ids', 'hide_rules', 'updated_at'],
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
