import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  EnrollmentStatusLogEntry,
  EnrollmentStatusLogEntryDraft,
} from '../../../../domain/types/enrollment-status-log-entry';
import { EnrollmentStatusLogRepository } from '../../enrollment-status-log.repository';
import { EnrollmentStatusLogEntity } from '../entities/enrollment-status-log.entity';
import { EnrollmentStatusLogMapper } from '../mappers/enrollment-status-log.mapper';

/**
 * TypeORM-backed adapter for `EnrollmentStatusLogRepository`. Mirrors the
 * `EnrollmentRelationalRepository` tenant-scoped EntityManager pattern so
 * appends and reads run inside the same RLS-scoped transaction as the
 * triggering service call.
 */
@Injectable()
export class EnrollmentStatusLogRelationalRepository extends EnrollmentStatusLogRepository {
  constructor(
    @InjectRepository(EnrollmentStatusLogEntity)
    private readonly repo: Repository<EnrollmentStatusLogEntity>,
  ) {
    super();
  }

  async append(
    kindergartenId: string,
    draft: EnrollmentStatusLogEntryDraft,
  ): Promise<EnrollmentStatusLogEntry> {
    const repo = this.manager().getRepository(EnrollmentStatusLogEntity);
    // Defensive — the service should already be passing the correct kg_id on
    // the draft, but if it desync'd the column name and the parameter, the
    // RLS WITH CHECK predicate would reject the row at the DB level. Mirror
    // the value to keep behaviour consistent with the explicit-tenant
    // contract on read paths.
    const insertResult = await repo.insert({
      ...EnrollmentStatusLogMapper.draftToInsert(draft),
      kindergarten_id: kindergartenId,
    });
    const insertedId = insertResult.identifiers[0]?.id as string | undefined;
    if (!insertedId) {
      throw new Error(
        `enrollment_status_log_insert_no_id:${draft.enrollmentId}`,
      );
    }
    const row = await repo.findOne({
      where: { id: insertedId, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `enrollment_status_log_readback_failed:${insertedId}@${kindergartenId}`,
      );
    }
    return EnrollmentStatusLogMapper.toDomain(row);
  }

  async listForEnrollment(
    kindergartenId: string,
    enrollmentId: string,
  ): Promise<EnrollmentStatusLogEntry[]> {
    const rows = await this.manager()
      .getRepository(EnrollmentStatusLogEntity)
      .createQueryBuilder('l')
      .where('l.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('l.enrollment_id = :eid', { eid: enrollmentId })
      .orderBy('l.created_at', 'DESC')
      .getMany();
    return rows.map((r) => EnrollmentStatusLogMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
