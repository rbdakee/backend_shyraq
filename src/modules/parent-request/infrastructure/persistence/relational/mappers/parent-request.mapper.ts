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
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
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
