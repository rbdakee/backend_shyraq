import {
  ParentRequest,
  ParentRequestStatus,
  ParentRequestType,
  ParentRequestRecipientType,
} from './domain/entities/parent-request.entity';

export interface CreateParentRequestInput {
  kindergartenId: string;
  childId: string;
  requesterUserId: string;
  requestType: ParentRequestType;
  dateFrom: Date | null;
  dateTo: Date | null;
  details: Record<string, unknown>;
  recipientType: ParentRequestRecipientType;
  recipientStaffId: string | null;
}

export interface ListParentRequestsFilter {
  kindergartenId: string;
  status?: ParentRequestStatus;
  requestType?: ParentRequestType;
  childId?: string;
  requesterUserId?: string;
  recipientStaffId?: string;
  recipientType?: 'admin' | 'mentor' | 'specialist';
  /** Optional cursor-based pagination anchor: `created_at,id` (ISO string + uuid). */
  cursor?: string;
  limit?: number;
}

export abstract class ParentRequestRepository {
  abstract create(input: CreateParentRequestInput): Promise<ParentRequest>;
  abstract findById(
    id: string,
    kindergartenId: string,
  ): Promise<ParentRequest | null>;
  abstract list(filter: ListParentRequestsFilter): Promise<ParentRequest[]>;

  /**
   * Conditional UPDATE: `SET … WHERE id=? AND kindergarten_id=? AND status=expectedStatus`.
   * Returns the updated entity if exactly 1 row was affected (transition succeeded),
   * or `null` if 0 rows were affected (race lost — request already processed).
   */
  abstract updateStatusConditional(
    id: string,
    kindergartenId: string,
    expectedStatus: ParentRequestStatus,
    nextStatus: ParentRequestStatus,
    patch: {
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      reviewNote?: string | null;
      updatedAt: Date;
    },
  ): Promise<ParentRequest | null>;
}
