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

/**
 * Cursor anchor for `(created_at DESC, id DESC)` pagination on parent_requests.
 *
 * B22b T7 M16: typed struct, not a raw string. The service is responsible
 * for base64-encoding/decoding at the HTTP edge — repos never see the
 * wire format. Composite `(createdAt, id)` is required because two
 * requests can share a `created_at` millisecond and a naive single-key
 * cursor would either skip rows or echo duplicates across pages.
 */
export interface ParentRequestCursor {
  createdAt: Date;
  id: string;
}

/**
 * Cross-tenant variant of {@link ListParentRequestsFilter}: keyed on the
 * requesting parent's `requesterUserId` instead of `kindergartenId`. Used by
 * the parent-side list endpoint when the JWT carries no `kindergarten_id`
 * (multi-kg parent) — the lookup fans out over every kindergarten the parent
 * filed a request in. Requester-ownership IS the authorisation: a row is only
 * returned when `requester_user_id = requesterUserId`, so the cross-tenant
 * read is bounded to the caller's own requests.
 */
export interface ListParentRequestsCrossTenantFilter {
  requesterUserId: string;
  status?: ParentRequestStatus;
  requestType?: ParentRequestType;
  childId?: string;
  cursor?: ParentRequestCursor;
  limit?: number;
}

export interface ListParentRequestsFilter {
  kindergartenId: string;
  status?: ParentRequestStatus;
  requestType?: ParentRequestType;
  childId?: string;
  /**
   * Optional group-scoped filter. JOINs `children` and matches
   * `child.current_group_id`. Surfaced via staff/admin list endpoints — see
   * `ListParentRequestsQueryDto.group_id`.
   */
  groupId?: string;
  requesterUserId?: string;
  recipientStaffId?: string;
  recipientType?: 'admin' | 'mentor' | 'specialist';
  /**
   * Optional pagination anchor — see `ParentRequestCursor`. The repository
   * applies it as
   * `WHERE (created_at < $cursorAt OR (created_at = $cursorAt AND id < $cursorId))`
   * over the canonical `(created_at DESC, id DESC)` ordering. Service
   * decodes the wire base64 cursor before passing it down.
   */
  cursor?: ParentRequestCursor;
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
   * Cross-tenant lookup by id only — used by the parent-side
   * `ParentRequestAccessGuard` to resolve the request's owning kindergarten
   * before tenant scope is known. Bypasses RLS via `app.bypass_rls=true`
   * inside its own transaction; the guard pins the resolved kg onto
   * `req.tenant` and the service then re-checks requester-ownership in that
   * kg, so the cross-tenant read never reaches the caller unguarded.
   *
   * Default no-op so older in-memory fakes compile; relational impl overrides.
   */
  findByIdCrossTenant(_id: string): Promise<ParentRequest | null> {
    return Promise.resolve(null);
  }

  /**
   * Cross-tenant list of the caller's OWN requests across every kindergarten,
   * ordered `(created_at DESC, id DESC)` with the same cursor semantics as
   * {@link list}. Bypasses RLS via `app.bypass_rls=true` inside its own
   * transaction; requester-ownership (`requester_user_id = requesterUserId`)
   * bounds the result to the caller's own rows. Used by the parent list
   * endpoint when the JWT has no `kindergarten_id`.
   *
   * Default no-op so older in-memory fakes compile; relational impl overrides.
   */
  listForRequesterCrossTenant(
    _filter: ListParentRequestsCrossTenantFilter,
  ): Promise<ParentRequest[]> {
    return Promise.resolve([]);
  }

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

  /**
   * Partial UPDATE that only writes `invoice_id`. Used by the B13 late_pickup
   * hook to link a freshly-generated invoice back onto the parent_request.
   * Throws when the row is missing (defensive — callers always look up the
   * row first via `findById`, so a 0-row UPDATE here means concurrent
   * deletion or a tenant-mismatch).
   */
  abstract setInvoiceId(
    kindergartenId: string,
    parentRequestId: string,
    invoiceId: string,
  ): Promise<void>;
}
