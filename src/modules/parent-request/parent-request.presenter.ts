import { ParentRequest } from './domain/entities/parent-request.entity';
import { ParentRequestMessage } from './domain/entities/parent-request-message.entity';
import {
  ParentRequestListResponseDto,
  ParentRequestResponseDto,
} from './dto/parent-request.response.dto';
import {
  ParentRequestMessageListResponseDto,
  ParentRequestMessageResponseDto,
} from './dto/parent-request-message.response.dto';

/**
 * Domain → response-DTO mappers for the parent-request module.
 *
 * snake_case wire keys per project endpoints.md convention; presenter does
 * the conversion from camelCase domain state. Pure (no Nest / TypeORM imports)
 * so controllers stay thin and assertions in service-unit specs can reuse the
 * same shapes.
 */
export const ParentRequestPresenter = {
  request(pr: ParentRequest): ParentRequestResponseDto {
    const s = pr.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      requester_user_id: s.requesterUserId,
      request_type: s.requestType,
      status: s.status,
      date_from: s.dateFrom ? toIsoDate(s.dateFrom) : null,
      date_to: s.dateTo ? toIsoDate(s.dateTo) : null,
      details: s.details,
      recipient_type: s.recipientType,
      recipient_staff_id: s.recipientStaffId,
      reviewed_by: s.reviewedBy,
      reviewed_at: s.reviewedAt ? s.reviewedAt.toISOString() : null,
      review_note: s.reviewNote,
      invoice_id: s.invoiceId,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  list(
    items: ParentRequest[],
    nextCursor: string | null,
  ): ParentRequestListResponseDto {
    return {
      items: items.map((pr) => ParentRequestPresenter.request(pr)),
      next_cursor: nextCursor,
    };
  },

  message(m: ParentRequestMessage): ParentRequestMessageResponseDto {
    const s = m.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      parent_request_id: s.parentRequestId,
      author_user_id: s.authorUserId,
      author_staff_id: s.authorStaffId,
      body: s.body,
      attachments: s.attachments,
      created_at: s.createdAt.toISOString(),
    };
  },

  messageList(
    items: ParentRequestMessage[],
    nextCursor: string | null,
  ): ParentRequestMessageListResponseDto {
    return {
      items: items.map((m) => ParentRequestPresenter.message(m)),
      next_cursor: nextCursor,
    };
  },
};

/**
 * Render a Date as `YYYY-MM-DD` (UTC). Postgres `date` columns lose the
 * time-of-day; we surface a pure date string to the wire so the client
 * doesn't have to strip a phantom T00:00:00Z when displaying.
 */
function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
