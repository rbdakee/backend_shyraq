import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { PickupRequest } from '../../../../domain/entities/pickup-request.entity';
import {
  CreatePickupRequestRow,
  ListPickupFilters,
  PickupRequestPatch,
  PickupRequestRepository,
  PickupRequestUpdateOpts,
} from '../../pickup-request.repository';
import { PickupRequestTypeOrmEntity } from '../entities/pickup-request.typeorm.entity';
import { PickupRequestMapper } from '../mappers/pickup-request.mapper';

@Injectable()
export class PickupRequestRelationalRepository extends PickupRequestRepository {
  constructor(
    @InjectRepository(PickupRequestTypeOrmEntity)
    private readonly repo: Repository<PickupRequestTypeOrmEntity>,
  ) {
    super();
  }

  async create(input: CreatePickupRequestRow): Promise<PickupRequest> {
    const m = this.manager();
    const insertResult = await m
      .getRepository(PickupRequestTypeOrmEntity)
      .insert({
        kindergarten_id: input.kindergartenId,
        child_id: input.childId,
        requested_by_user_id: input.requestedByUserId,
        trusted_person_id: input.trustedPersonId,
        trusted_person_phone: input.trustedPersonPhone,
        trusted_person_name: input.trustedPersonName,
        trusted_person_iin: input.trustedPersonIin,
        expires_at: input.expiresAt,
        parent_request_id: input.parentRequestId ?? null,
        status: 'otp_sent',
      });
    const newId = (insertResult.identifiers[0] as { id: string } | undefined)
      ?.id;
    if (!newId) {
      throw new Error('pickup_request_create_no_identifier_returned');
    }
    const row = await m
      .getRepository(PickupRequestTypeOrmEntity)
      .findOne({ where: { id: newId } });
    if (!row) {
      throw new Error(`pickup_request_create_readback_failed:${newId}`);
    }
    return PickupRequestMapper.toDomain(row);
  }

  async findById(id: string): Promise<PickupRequest | null> {
    const row = await this.manager()
      .getRepository(PickupRequestTypeOrmEntity)
      .findOne({ where: { id } });
    return row ? PickupRequestMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(id: string): Promise<PickupRequest | null> {
    // `setLock('pessimistic_write')` issues `SELECT ... FOR UPDATE`. Caller
    // is responsible for being inside a TX — outside one Postgres ignores
    // the lock and the call degrades to a plain SELECT.
    const row = await this.manager()
      .createQueryBuilder(PickupRequestTypeOrmEntity, 'pr')
      .setLock('pessimistic_write')
      .where('pr.id = :id', { id })
      .getOne();
    return row ? PickupRequestMapper.toDomain(row) : null;
  }

  async listByKindergarten(
    filters: ListPickupFilters,
  ): Promise<PickupRequest[]> {
    const m = this.manager();
    const qb = m
      .createQueryBuilder(PickupRequestTypeOrmEntity, 'pr')
      .where('pr.kindergarten_id = :kgId', { kgId: filters.kindergartenId });

    if (filters.status) {
      qb.andWhere('pr.status = :status', { status: filters.status });
    }

    if (filters.groupId) {
      // Join `children.current_group_id` to filter by group. We use the raw
      // table name rather than a TypeORM relation because the entity does
      // not declare relations (kept minimal — see comment in
      // `pickup-request.typeorm.entity.ts`).
      qb.innerJoin(
        'children',
        'c',
        'c.id = pr.child_id AND c.current_group_id = :groupId',
        { groupId: filters.groupId },
      );
    }

    qb.orderBy('pr.created_at', 'DESC');

    const rows = await qb.getMany();
    return rows.map((r) => PickupRequestMapper.toDomain(r));
  }

  async update(
    id: string,
    patch: PickupRequestPatch,
    opts: PickupRequestUpdateOpts = {},
  ): Promise<boolean> {
    const m = this.manager();
    const setObj: Partial<PickupRequestTypeOrmEntity> = {};
    if (patch.status !== undefined) setObj.status = patch.status;
    if (patch.otpRef !== undefined) setObj.otp_ref = patch.otpRef;
    if (patch.validatedBy !== undefined)
      setObj.validated_by = patch.validatedBy;
    if (patch.validatedAt !== undefined)
      setObj.validated_at = patch.validatedAt;
    if (patch.attendanceEventId !== undefined) {
      setObj.attendance_event_id = patch.attendanceEventId;
    }
    if (Object.keys(setObj).length === 0) return true;
    const qb = m
      .createQueryBuilder()
      .update(PickupRequestTypeOrmEntity)
      .set(setObj)
      .where('id = :id', { id });
    if (opts.expectedStatus !== undefined) {
      qb.andWhere('status = :expectedStatus', {
        expectedStatus: opts.expectedStatus,
      });
    }
    const result = await qb.execute();
    // `affected` is null on some driver paths (very old typeorm). When
    // the caller passed an `expectedStatus` the contract is "guard-aware"
    // — we treat null/undefined as success here; PG returns the count
    // for UPDATEs through pg-driver so this is exercised in tests.
    const affected = result.affected ?? 1;
    return affected > 0;
  }

  /**
   * `pg_advisory_xact_lock(hashtext('pickup:validate:'||requestId)::bigint)` —
   * released automatically when the surrounding TX commits/rolls back.
   * Goes through `manager()` so it joins the ambient HTTP TX (set up by
   * `TenantContextInterceptor`); when no ambient TX is present the call
   * still succeeds but the lock is released at the implicit per-statement
   * TX boundary, effectively making it a no-op — safe for CLI / non-HTTP
   * code paths (those don't race).
   */
  async acquireValidateAdvisoryLock(requestId: string): Promise<void> {
    const m = this.manager();
    await m.query(
      `SELECT pg_advisory_xact_lock(hashtext('pickup:validate:' || $1)::bigint)`,
      [requestId],
    );
  }

  /**
   * Selects the EntityManager bound to the active tenant transaction (set
   * by `TenantContextInterceptor`) when present, otherwise falls back to
   * the repository's default pool manager. Mirrors identity-qr.
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
