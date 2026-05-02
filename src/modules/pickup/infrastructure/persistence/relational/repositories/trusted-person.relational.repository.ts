import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { TrustedPerson } from '../../../../domain/entities/trusted-person.entity';
import {
  CreateTrustedPersonRow,
  TrustedPersonPatch,
  TrustedPersonRepository,
} from '../../trusted-person.repository';
import { TrustedPersonTypeOrmEntity } from '../entities/trusted-person.typeorm.entity';
import { TrustedPersonMapper } from '../mappers/trusted-person.mapper';

@Injectable()
export class TrustedPersonRelationalRepository extends TrustedPersonRepository {
  constructor(
    @InjectRepository(TrustedPersonTypeOrmEntity)
    private readonly repo: Repository<TrustedPersonTypeOrmEntity>,
  ) {
    super();
  }

  async create(input: CreateTrustedPersonRow): Promise<TrustedPerson> {
    const m = this.manager();
    // INSERT-then-readback so we observe the DB-assigned `id` and
    // `created_at`. Mirrors the AttendanceEvent / QrToken patterns.
    const insertResult = await m
      .getRepository(TrustedPersonTypeOrmEntity)
      .insert({
        kindergarten_id: input.kindergartenId,
        child_id: input.childId,
        added_by_user_id: input.addedByUserId,
        full_name: input.fullName,
        phone: input.phone,
        iin: input.iin,
        relation: input.relation,
        photo_url: input.photoUrl,
        is_one_time: input.isOneTime,
        is_active: true,
      });
    const newId = (insertResult.identifiers[0] as { id: string } | undefined)
      ?.id;
    if (!newId) {
      throw new Error('trusted_person_create_no_identifier_returned');
    }
    const row = await m
      .getRepository(TrustedPersonTypeOrmEntity)
      .findOne({ where: { id: newId } });
    if (!row) {
      throw new Error(`trusted_person_create_readback_failed:${newId}`);
    }
    return TrustedPersonMapper.toDomain(row);
  }

  async findById(id: string): Promise<TrustedPerson | null> {
    const row = await this.manager()
      .getRepository(TrustedPersonTypeOrmEntity)
      .findOne({ where: { id } });
    return row ? TrustedPersonMapper.toDomain(row) : null;
  }

  async listByChild(
    kindergartenId: string,
    childId: string,
  ): Promise<TrustedPerson[]> {
    // T7-5 LOW#6: filter to active rows only (`is_active=true AND
    // revoked_at IS NULL`) so the parent-app list endpoint matches the
    // docs/endpoints.md §4.6 contract ("Возвращает is_active=true
    // записи"). Historical / revoked rows live in the audit DB but the
    // client never sees them through `GET .../trusted-people`.
    const rows = await this.manager()
      .getRepository(TrustedPersonTypeOrmEntity)
      .createQueryBuilder('tp')
      .where('tp.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('tp.child_id = :cid', { cid: childId })
      .andWhere('tp.is_active = true')
      .andWhere('tp.revoked_at IS NULL')
      .orderBy('tp.created_at', 'DESC')
      .getMany();
    return rows.map((r) => TrustedPersonMapper.toDomain(r));
  }

  async update(
    id: string,
    patch: TrustedPersonPatch,
  ): Promise<TrustedPerson | null> {
    const m = this.manager();
    const setObj: Partial<TrustedPersonTypeOrmEntity> = {};
    if (patch.fullName !== undefined) setObj.full_name = patch.fullName;
    if (patch.phone !== undefined) setObj.phone = patch.phone;
    if (patch.iin !== undefined) setObj.iin = patch.iin;
    if (patch.relation !== undefined) setObj.relation = patch.relation;
    if (patch.photoUrl !== undefined) setObj.photo_url = patch.photoUrl;
    if (patch.isOneTime !== undefined) setObj.is_one_time = patch.isOneTime;
    if (patch.isActive !== undefined) setObj.is_active = patch.isActive;
    if (Object.keys(setObj).length === 0) {
      // Empty patch — short-circuit to a plain read so the caller still
      // gets back the current row (or null when not visible).
      return this.findById(id);
    }
    await m.getRepository(TrustedPersonTypeOrmEntity).update({ id }, setObj);
    return this.findById(id);
  }

  async markRevoked(id: string, now: Date): Promise<void> {
    const m = this.manager();
    await m
      .createQueryBuilder()
      .update(TrustedPersonTypeOrmEntity)
      .set({ revoked_at: now, is_active: false })
      .where('id = :id AND revoked_at IS NULL', { id })
      .execute();
  }

  async markUsed(id: string, now: Date, deactivate: boolean): Promise<boolean> {
    // T7-5 HIGH#2: guarded UPDATE so concurrent validates of the same
    // ONE-TIME trusted_people row resolve to exactly one winner. Without
    // the `used_at IS NULL` guard, two staff devices validating two
    // pickup_requests bound to the same `is_one_time=true` row could
    // both call markUsed and both succeed — letting a one-time row back
    // a second pickup. The advisory lock per pickup_request_id only
    // serializes the SAME request, not two requests sharing a tp row.
    //
    // For non-one-time rows the guard would be wrong — `used_at` is
    // intentionally a "last used" audit field that re-stamps on every
    // pickup, so we drop the `used_at IS NULL` constraint on that
    // branch. The `revoked_at IS NULL AND is_active = true` part is
    // still useful as defense-in-depth for the access drift case
    // (parent revokes mid-flow), in which case the upstream
    // `isAvailableForPickup()` check should already have refused.
    const m = this.manager();
    const qb = m
      .createQueryBuilder()
      .update(TrustedPersonTypeOrmEntity)
      .set(deactivate ? { used_at: now, is_active: false } : { used_at: now })
      .where('id = :id', { id })
      .andWhere('revoked_at IS NULL')
      .andWhere('is_active = true');
    if (deactivate) {
      qb.andWhere('used_at IS NULL');
    }
    const result = await qb.execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * Selects the EntityManager bound to the active tenant transaction (set
   * by `TenantContextInterceptor`) when present, otherwise falls back to
   * the repository's default pool manager. Mirrors the identity-qr pattern.
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
