import {
  ParentRequest,
  ParentRequestState,
} from '../../../../domain/entities/parent-request.entity';
import { ParentRequestTypeOrmEntity } from '../entities/parent-request.typeorm.entity';

/**
 * Domain ↔ persistence mapper for the ParentRequest aggregate.
 * Lives in the relational subtree because it knows the TypeORM entity shape;
 * the domain/application layers do not.
 */
export class ParentRequestMapper {
  static toDomain(row: ParentRequestTypeOrmEntity): ParentRequest {
    const state: ParentRequestState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      childId: row.childId,
      requesterUserId: row.requesterUserId,
      requestType: row.requestType,
      status: row.status,
      // TypeORM `date` columns come back from PG as plain strings ('YYYY-MM-DD'),
      // not JS Date objects. Normalise to midnight-UTC Date so presenter's
      // `toIsoDate(d)` (which calls `d.getUTCFullYear()`) does not throw.
      dateFrom: toDate(row.dateFrom),
      dateTo: toDate(row.dateTo),
      details: row.details ?? {},
      recipientType: row.recipientType ?? null,
      recipientStaffId: row.recipientStaffId,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      invoiceId: row.invoiceId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return ParentRequest.fromState(state);
  }
}

/**
 * Normalise a TypeORM `date` column value to a `Date | null`. TypeORM returns
 * PostgreSQL `date` values as ISO-date strings ('YYYY-MM-DD'), not JS Dates.
 * We convert to midnight-UTC so domain/presenter code can call `getUTCFullYear`
 * etc. without TypeError.
 */
function toDate(raw: Date | string | null | undefined): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return raw;
  // raw is a string from the PG 'date' column ('YYYY-MM-DD')
  return new Date(`${raw}T00:00:00.000Z`);
}
