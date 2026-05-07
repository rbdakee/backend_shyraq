import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { GroupStory } from '../../../../domain/entities/group-story.entity';
import { GroupStoryRepository } from '../../../../group-story.repository';
import { GroupStoryRelationalEntity } from '../entities/group-story.relational-entity';
import { GroupStoryMapper } from '../mappers/group-story.mapper';

@Injectable()
export class GroupStoryRelationalRepository extends GroupStoryRepository {
  constructor(
    @InjectRepository(GroupStoryRelationalEntity)
    private readonly repo: Repository<GroupStoryRelationalEntity>,
  ) {
    super();
  }

  async create(story: GroupStory): Promise<GroupStory> {
    const m = this.manager().getRepository(GroupStoryRelationalEntity);
    const row = GroupStoryMapper.toRelational(story);
    await m.insert(row);
    return story;
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<GroupStory | null> {
    const row = await this.manager()
      .getRepository(GroupStoryRelationalEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? GroupStoryMapper.toDomain(row) : null;
  }

  async delete(kindergartenId: string, id: string): Promise<boolean> {
    return this.deleteById(kindergartenId, id);
  }

  async deleteById(kindergartenId: string, id: string): Promise<boolean> {
    const m = this.manager().getRepository(GroupStoryRelationalEntity);
    const result = await m.delete({ id, kindergarten_id: kindergartenId });
    return (result.affected ?? 0) > 0;
  }

  async listActiveByGroup(
    kindergartenId: string,
    groupId: string,
    now: Date,
  ): Promise<GroupStory[]> {
    const rows = await this.manager()
      .getRepository(GroupStoryRelationalEntity)
      .createQueryBuilder('s')
      .where('s.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('s.group_id = :gid', { gid: groupId })
      .andWhere('s.expires_at > :now', { now })
      .orderBy('s.created_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .getMany();
    return rows.map((r) => GroupStoryMapper.toDomain(r));
  }

  async listActiveByGroupIds(
    kindergartenId: string,
    groupIds: string[],
    now: Date,
  ): Promise<GroupStory[]> {
    if (groupIds.length === 0) return [];
    const rows = await this.manager()
      .getRepository(GroupStoryRelationalEntity)
      .createQueryBuilder('s')
      .where('s.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere({ group_id: In(groupIds) })
      .andWhere('s.expires_at > :now', { now })
      .orderBy('s.created_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .getMany();
    return rows.map((r) => GroupStoryMapper.toDomain(r));
  }

  async incrementViews(kindergartenId: string, id: string): Promise<boolean> {
    const m = this.manager();
    const result = (await m.query(
      `UPDATE group_stories
          SET views = views + 1
        WHERE id = $1
          AND kindergarten_id = $2
        RETURNING 1`,
      [id, kindergartenId],
    )) as unknown[];
    return Array.isArray(result) && result.length > 0;
  }

  async listExpired(
    kindergartenId: string,
    now: Date,
    limit: number,
  ): Promise<GroupStory[]> {
    const rows = await this.manager()
      .getRepository(GroupStoryRelationalEntity)
      .createQueryBuilder('s')
      .where('s.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('s.expires_at <= :now', { now })
      .orderBy('s.expires_at', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .take(limit > 0 ? limit : 100)
      .getMany();
    return rows.map((r) => GroupStoryMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
