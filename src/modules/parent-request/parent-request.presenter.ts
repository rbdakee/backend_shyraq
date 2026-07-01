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
/**
 * Identity overlays threaded in from the service layer (`parent-request.service.ts`).
 * The domain stores only ids; the service resolves the display names (batched,
 * deduped, fail-closed) and passes them here so the presenter stays a pure
 * id → wire-shape mapper. All default to `null` so callers that have no overlay
 * (or a fail-closed empty map) render the field as null rather than crashing.
 */
export interface RequestNameOverlay {
  recipientStaffFullName?: string | null;
  reviewedByFullName?: string | null;
  childName?: string | null;
}

export const ParentRequestPresenter = {
  request(
    pr: ParentRequest,
    overlay: RequestNameOverlay = {},
  ): ParentRequestResponseDto {
    const s = pr.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      child_name: overlay.childName ?? null,
      requester_user_id: s.requesterUserId,
      request_type: s.requestType,
      status: s.status,
      date_from: s.dateFrom ? toIsoDate(s.dateFrom) : null,
      date_to: s.dateTo ? toIsoDate(s.dateTo) : null,
      details: s.details,
      recipient_type: s.recipientType,
      recipient_staff_id: s.recipientStaffId,
      recipient_staff_full_name: overlay.recipientStaffFullName ?? null,
      reviewed_by: s.reviewedBy,
      reviewed_by_full_name: overlay.reviewedByFullName ?? null,
      reviewed_at: s.reviewedAt ? s.reviewedAt.toISOString() : null,
      review_note: s.reviewNote,
      invoice_id: s.invoiceId,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  /**
   * Map a single request, picking its overlay names out of a
   * `Map<staffMemberId, string|null>` (produced by
   * `ParentRequestService.resolveRequestStaffNames`). Keeps the single-return
   * controllers thin — they resolve a batch-of-one then call this.
   */
  requestWithStaffNames(
    pr: ParentRequest,
    staffNames: Map<string, string | null>,
    childNames: Map<string, string> = new Map(),
  ): ParentRequestResponseDto {
    return ParentRequestPresenter.request(pr, {
      recipientStaffFullName: pr.recipientStaffId
        ? (staffNames.get(pr.recipientStaffId) ?? null)
        : null,
      reviewedByFullName: pr.reviewedBy
        ? (staffNames.get(pr.reviewedBy) ?? null)
        : null,
      childName: pr.childId ? (childNames.get(pr.childId) ?? null) : null,
    });
  },

  list(
    items: ParentRequest[],
    nextCursor: string | null,
    staffNames: Map<string, string | null> = new Map(),
    childNames: Map<string, string> = new Map(),
  ): ParentRequestListResponseDto {
    return {
      items: items.map((pr) =>
        ParentRequestPresenter.requestWithStaffNames(
          pr,
          staffNames,
          childNames,
        ),
      ),
      next_cursor: nextCursor,
    };
  },

  message(
    m: ParentRequestMessage,
    authorFullName: string | null = null,
  ): ParentRequestMessageResponseDto {
    const s = m.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      parent_request_id: s.parentRequestId,
      author_user_id: s.authorUserId,
      author_staff_id: s.authorStaffId,
      author_full_name: authorFullName,
      body: s.body,
      attachments: s.attachments,
      created_at: s.createdAt.toISOString(),
    };
  },

  messageList(
    items: ParentRequestMessage[],
    nextCursor: string | null,
    authorNames: Map<string, string | null> = new Map(),
  ): ParentRequestMessageListResponseDto {
    return {
      items: items.map((m) =>
        ParentRequestPresenter.message(m, authorNames.get(m.id) ?? null),
      ),
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
