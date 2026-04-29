import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ChildGuardian } from '../../../../domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '../../child-guardian.repository';
import { ChildGuardianEntity } from '../entities/child-guardian.entity';
import { ChildGuardianMapper } from '../mappers/child-guardian.mapper';

@Injectable()
export class ChildGuardianRelationalRepository extends ChildGuardianRepository {
  constructor(
    @InjectRepository(ChildGuardianEntity)
    private readonly repo: Repository<ChildGuardianEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  async create(guardian: ChildGuardian): Promise<void> {
    const repo = this.manager().getRepository(ChildGuardianEntity);
    const state = guardian.toState();
    await repo.insert({
      id: state.id,
      kindergarten_id: state.kindergartenId,
      child_id: state.childId,
      user_id: state.userId,
      role: state.role,
      status: state.status,
      has_approval_rights: state.hasApprovalRights,
      approved_by: state.approvedBy,
      approved_at: state.approvedAt,
      revoked_by: state.revokedBy,
      revoked_at: state.revokedAt,
      can_pickup: state.canPickup,
      permissions: state.permissions,
      permissions_updated_by: state.permissionsUpdatedBy,
      permissions_updated_at: state.permissionsUpdatedAt,
    });
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<ChildGuardian | null> {
    const row = await this.manager()
      .getRepository(ChildGuardianEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? ChildGuardianMapper.toDomain(row) : null;
  }

  async findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGuardian[]> {
    const rows = await this.manager()
      .getRepository(ChildGuardianEntity)
      .createQueryBuilder('g')
      .where('g.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('g.child_id = :cid', { cid: childId })
      .orderBy('g.created_at', 'ASC')
      .getMany();
    return rows.map((r) => ChildGuardianMapper.toDomain(r));
  }

  async findActiveByChildAndUser(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const row = await this.manager()
      .getRepository(ChildGuardianEntity)
      .createQueryBuilder('g')
      .where('g.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('g.child_id = :cid', { cid: childId })
      .andWhere('g.user_id = :uid', { uid: userId })
      .andWhere("g.status <> 'revoked'")
      .getOne();
    return row ? ChildGuardianMapper.toDomain(row) : null;
  }

  /**
   * Cross-tenant lookup. Used by ChildAccessGuard to determine whether the
   * caller is an approved guardian without prior knowledge of the child's
   * kindergarten. Runs inside a short transaction with `app.bypass_rls=true`.
   */
  async findApprovedByChildAndUserCrossTenant(
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const row = await manager
        .getRepository(ChildGuardianEntity)
        .createQueryBuilder('g')
        .where('g.child_id = :cid', { cid: childId })
        .andWhere('g.user_id = :uid', { uid: userId })
        .andWhere("g.status = 'approved'")
        .getOne();
      return row ? ChildGuardianMapper.toDomain(row) : null;
    });
  }

  async findByIdCrossTenant(guardianId: string): Promise<ChildGuardian | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const row = await manager
        .getRepository(ChildGuardianEntity)
        .findOne({ where: { id: guardianId } });
      return row ? ChildGuardianMapper.toDomain(row) : null;
    });
  }

  async findPendingForPrimary(
    kindergartenId: string,
    primaryUserId: string,
  ): Promise<ChildGuardian[]> {
    // Children where the caller is an approved primary, then any
    // pending_approval rows on those children.
    const rows = await this.manager()
      .getRepository(ChildGuardianEntity)
      .createQueryBuilder('g')
      .where('g.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere("g.status = 'pending_approval'")
      .andWhere(
        `g.child_id IN (
          SELECT g2.child_id FROM "child_guardians" g2
          WHERE g2.kindergarten_id = :kg
            AND g2.user_id = :uid
            AND g2.role = 'primary'
            AND g2.status = 'approved'
        )`,
        { uid: primaryUserId },
      )
      .orderBy('g.created_at', 'ASC')
      .getMany();
    return rows.map((r) => ChildGuardianMapper.toDomain(r));
  }

  async update(guardian: ChildGuardian): Promise<void> {
    const repo = this.manager().getRepository(ChildGuardianEntity);
    const state = guardian.toState();
    await repo.update(
      { id: state.id, kindergarten_id: state.kindergartenId },
      {
        role: state.role,
        status: state.status,
        has_approval_rights: state.hasApprovalRights,
        approved_by: state.approvedBy,
        approved_at: state.approvedAt,
        revoked_by: state.revokedBy,
        revoked_at: state.revokedAt,
        can_pickup: state.canPickup,
        permissions: state.permissions,
        permissions_updated_by: state.permissionsUpdatedBy,
        permissions_updated_at: state.permissionsUpdatedAt,
      },
    );
  }

  async countApprovalRights(
    kindergartenId: string,
    childId: string,
  ): Promise<number> {
    return this.manager()
      .getRepository(ChildGuardianEntity)
      .createQueryBuilder('g')
      .where('g.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('g.child_id = :cid', { cid: childId })
      .andWhere("g.status = 'approved'")
      .andWhere('g.has_approval_rights = true')
      .getCount();
  }

  async listApprovedKindergartenIdsByUserId(userId: string): Promise<string[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = await manager
        .getRepository(ChildGuardianEntity)
        .createQueryBuilder('g')
        .select('DISTINCT g.kindergarten_id', 'kindergarten_id')
        .where('g.user_id = :uid', { uid: userId })
        .andWhere("g.status = 'approved'")
        .getRawMany<{ kindergarten_id: string }>();
      return rows.map((r) => r.kindergarten_id);
    });
  }

  async findApprovedByUser(
    kindergartenId: string,
    userId: string,
  ): Promise<ChildGuardian[]> {
    const rows = await this.manager()
      .getRepository(ChildGuardianEntity)
      .createQueryBuilder('g')
      .where('g.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('g.user_id = :uid', { uid: userId })
      .andWhere("g.status = 'approved'")
      .orderBy('g.created_at', 'ASC')
      .getMany();
    return rows.map((r) => ChildGuardianMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
