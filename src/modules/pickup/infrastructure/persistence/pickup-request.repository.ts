import {
  PickupRequest,
  PickupRequestStatus,
} from '../../domain/entities/pickup-request.entity';

export interface CreatePickupRequestRow {
  kindergartenId: string;
  childId: string;
  requestedByUserId: string;
  trustedPersonId: string | null;
  trustedPersonPhone: string;
  trustedPersonName: string;
  trustedPersonIin: string | null;
  expiresAt: Date;
  parentRequestId?: string | null;
}

export interface ListPickupFilters {
  kindergartenId: string;
  groupId?: string | null;
  status?: PickupRequestStatus | null;
}

export type PickupRequestPatch = Partial<{
  status: PickupRequestStatus;
  otpRef: string | null;
  validatedBy: string | null;
  validatedAt: Date | null;
  attendanceEventId: string | null;
}>;

/**
 * Persistence port for the PickupRequest aggregate (B11). Methods exchange
 * domain objects, not TypeORM entities.
 *
 * Tenant-scoped: relational impl participates in the ambient tenant TX so
 * RLS filters rows automatically. The advisory-lock acquisition is wired
 * here (rather than as a separate port) because it is intrinsically tied
 * to a `pickup_request.id` and runs through the same `EntityManager` to
 * inherit the surrounding transaction.
 */
export abstract class PickupRequestRepository {
  /**
   * Inserts a new pickup_requests row in `otp_sent` status. Returns the
   * persisted domain aggregate. `otp_ref` is null at this point — the
   * service stamps it via `update(..., { otpRef })` after `SmsPort.send`
   * returns its txnId.
   */
  abstract create(input: CreatePickupRequestRow): Promise<PickupRequest>;

  /** Returns the row by id, or null when not visible / not found. */
  abstract findById(id: string): Promise<PickupRequest | null>;

  /**
   * Same as `findById` but issues `SELECT ... FOR UPDATE`, blocking other
   * transactions from concurrently mutating the row. Used by the staff
   * `validate-otp` flow inside the advisory-locked TX so the read is
   * coherent with the subsequent UPDATE.
   *
   * MUST be called inside a transaction — outside one Postgres ignores
   * the row-level lock and the call degrades to a plain SELECT.
   */
  abstract findByIdForUpdate(id: string): Promise<PickupRequest | null>;

  /**
   * Lists pickup_requests within tenant scope, optionally filtered by
   * `groupId` (joins `children.current_group_id`) and `status`. Sorted by
   * `created_at DESC` so the staff dashboard shows newest first.
   */
  abstract listByKindergarten(
    filters: ListPickupFilters,
  ): Promise<PickupRequest[]>;

  /**
   * Partial update of mutable fields. The patch is applied verbatim; the
   * service is responsible for state-machine validity (it transitions the
   * domain aggregate first, then writes the new shape via this method).
   */
  abstract update(id: string, patch: PickupRequestPatch): Promise<void>;

  /**
   * Acquires `pg_advisory_xact_lock(hashtext('pickup:validate:'||requestId))`.
   * Released automatically when the surrounding TX commits or rolls back.
   * Used by the staff validate-OTP flow to serialise concurrent attempts
   * on the same `pickup_request.id` (two staff devices, network retry,
   * etc.). Without the lock both transactions could read otp_sent and
   * both transition to validated, producing two attendance_events.
   *
   * Implementations should silently no-op when no ambient TX is available
   * (CLI scripts / integration tests outside the HTTP pipeline). T6 will
   * exercise the real lock against PG via a race-integration spec, mirror
   * of B10 `identity-qr.race.integration.spec.ts`.
   */
  abstract acquireValidateAdvisoryLock(requestId: string): Promise<void>;
}
