import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ParentRequestMessage } from '../../../../domain/entities/parent-request-message.entity';
import {
  CreateParentRequestMessageInput,
  ParentRequestMessageRepository,
} from '../../../../parent-request-message.repository';
import { ParentRequestMessageTypeOrmEntity } from '../entities/parent-request-message.typeorm.entity';
import { ParentRequestMessageMapper } from '../mappers/parent-request-message.mapper';

@Injectable()
export class ParentRequestMessageRelationalRepository extends ParentRequestMessageRepository {
  constructor(
    @InjectRepository(ParentRequestMessageTypeOrmEntity)
    private readonly repo: Repository<ParentRequestMessageTypeOrmEntity>,
  ) {
    super();
  }

  /**
   * Returns the EntityManager bound to the active tenant transaction when
   * present, otherwise falls back to the repository's default pool manager.
   */
  private manager(): EntityManager {
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async create(
    input: CreateParentRequestMessageInput,
  ): Promise<ParentRequestMessage> {
    const m = this.manager();
    const row = m.create(ParentRequestMessageTypeOrmEntity, {
      kindergartenId: input.kindergartenId,
      parentRequestId: input.parentRequestId,
      authorUserId: input.authorUserId,
      authorStaffId: input.authorStaffId,
      body: input.body,
      attachments: input.attachments,
    });
    const saved = await m.save(ParentRequestMessageTypeOrmEntity, row);
    return ParentRequestMessageMapper.toDomain(saved);
  }

  async listByRequestId(
    parentRequestId: string,
    kindergartenId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ParentRequestMessage[]> {
    const m = this.manager();
    const qb = m
      .createQueryBuilder(ParentRequestMessageTypeOrmEntity, 'msg')
      .where('msg.parentRequestId = :prId', { prId: parentRequestId })
      .andWhere('msg.kindergartenId = :kgId', { kgId: kindergartenId })
      .orderBy('msg.createdAt', 'ASC')
      .addOrderBy('msg.id', 'ASC')
      .limit(limit);

    // Cursor-based pagination: cursor is ISO timestamp of last seen message.
    // Returns messages created strictly after the cursor timestamp.
    if (cursor) {
      qb.andWhere('msg.createdAt > :cursor', { cursor });
    }

    const rows = await qb.getMany();
    return rows.map(ParentRequestMessageMapper.toDomain);
  }
}
