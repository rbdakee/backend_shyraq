/**
 * NotificationPort — abstract sink for cross-module domain notifications.
 *
 * Skeleton in P5: real fan-out (push, email, in-app) lives in later phases.
 * For now the logging adapter writes a structured line to nest's Logger so
 * tests can assert that the right hooks fired without coupling to a transport.
 *
 * Each method takes a tenant-scoped envelope; recipients are spelled out
 * explicitly (no implicit broadcast). The service layer is responsible for
 * resolving recipient ids from guardian/staff tables before calling.
 */

export interface GuardianPendingApprovalEvent {
  kindergartenId: string;
  childId: string;
  childFullName: string;
  primaryUserId: string;
  requesterUserId: string;
  role: string;
}

export interface GuardianApprovedEvent {
  kindergartenId: string;
  childId: string;
  guardianUserId: string;
  approvedBy: string;
  hasApprovalRights: boolean;
}

export interface GuardianRejectedEvent {
  kindergartenId: string;
  childId: string;
  guardianUserId: string;
  rejectedBy: string;
}

export interface GuardianRevokedEvent {
  kindergartenId: string;
  childId: string;
  guardianUserId: string;
  revokedBy: string;
}

export interface ChildTransferredEvent {
  kindergartenId: string;
  childId: string;
  fromGroupId: string | null;
  toGroupId: string;
  transferredBy: string;
  recipientUserIds: string[];
}

export interface PermissionsUpdatedEvent {
  kindergartenId: string;
  childId: string;
  guardianUserId: string;
  updatedBy: string;
  effectivePermissions: Record<string, boolean>;
}

// ── B8 Attendance & Timeline events ────────────────────────────────────────

export interface AttendanceCheckInEvent {
  kindergartenId: string;
  childId: string;
  eventId: string;
  recordedAt: Date;
  recordedByStaffMemberId: string | null;
}

export interface AttendanceCheckOutEvent extends AttendanceCheckInEvent {
  /**
   * Null only in the B11 OTP-pickup branch where the picker is a non-user
   * trusted person known just by their phone snapshot on the
   * pickup_request. The legacy staff-driven branch always sets a non-null
   * userId (the picking-up guardian).
   */
  pickupUserId: string | null;
  /** Always null in B8 — set by B11 OTP-pickup flow. */
  pickupRequestId: string | null;
}

export interface DailyStatusChangedEvent {
  kindergartenId: string;
  childId: string;
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  /** child_intraday_status enum value. */
  status: string;
  setByStaffMemberId: string | null;
}

export interface TimelineEntryCreatedEvent {
  kindergartenId: string;
  childId: string;
  entryId: string;
  /** timeline_entry_type enum value. */
  entryType: string;
  entryTime: Date;
  recordedByStaffMemberId: string | null;
}

// ── B11 Pickup OTP events ──────────────────────────────────────────────────

/**
 * Event fired by `PickupRequestService.sendOtp` after the SMS has been
 * dispatched to the trusted person. The recipient of the in-app/push
 * notification is the requester (parent who initiated the pickup_request)
 * — the SMS itself goes to the trusted-person phone via `SmsPort` and is
 * NOT relayed by the dispatcher.
 */
export interface PickupOtpSentEvent {
  kindergartenId: string;
  childId: string;
  pickupRequestId: string;
  /** The user that initiated the pickup_request (typically the parent). */
  requesterUserId: string;
  /** Snapshot — used to render the notification body. */
  trustedPersonName: string;
}

/**
 * Event fired by `PickupRequestService.validateOtp` after the OTP has been
 * accepted and the attendance check-out + pickup_request transition has
 * committed. Recipients are the child's approved guardians AND the
 * requester (parent who started the flow).
 */
export interface PickupValidatedEvent {
  kindergartenId: string;
  childId: string;
  pickupRequestId: string;
  /** The user that initiated the pickup_request (typically the parent). */
  requesterUserId: string;
  /** Snapshot — used to render the notification body. */
  trustedPersonName: string;
  /** The attendance_event row created as the side-effect of validation. */
  attendanceEventId: string;
  validatedAt: Date;
}

// ── B9 self-events (T8 call-sites) ─────────────────────────────────────────

/**
 * Self-event fired by a guardian who unlinks themselves (parent-app
 * `DELETE /me/children/:cid`). The recipient is the guardian themselves —
 * confirmation push + history row. T8 wires the actual emit site.
 */
export interface GuardianSelfRevokedEvent {
  kindergartenId: string;
  childId: string;
  /** The user that unlinked themselves — also the recipient of the notification. */
  userId: string;
  revokedAt: Date;
}

export abstract class NotificationPort {
  abstract notifyGuardianPendingApproval(
    event: GuardianPendingApprovalEvent,
  ): Promise<void>;
  abstract notifyGuardianApproved(event: GuardianApprovedEvent): Promise<void>;
  abstract notifyGuardianRejected(event: GuardianRejectedEvent): Promise<void>;
  abstract notifyGuardianRevoked(event: GuardianRevokedEvent): Promise<void>;
  abstract notifyChildTransferred(event: ChildTransferredEvent): Promise<void>;
  abstract notifyPermissionsUpdated(
    event: PermissionsUpdatedEvent,
  ): Promise<void>;

  // ── B8 Attendance & Timeline ─────────────────────────────────────────────

  abstract notifyAttendanceCheckIn(
    event: AttendanceCheckInEvent,
  ): Promise<void>;
  abstract notifyAttendanceCheckOut(
    event: AttendanceCheckOutEvent,
  ): Promise<void>;
  abstract notifyDailyStatusChanged(
    event: DailyStatusChangedEvent,
  ): Promise<void>;
  abstract notifyTimelineEntryCreated(
    event: TimelineEntryCreatedEvent,
  ): Promise<void>;

  // ── B9 self-events ─────────────────────────────────────────────────────

  /**
   * Triggered when a non-primary guardian unlinks themselves. The recipient
   * (`event.userId`) is the guardian themselves — a self-confirmation event,
   * NOT a fan-out to the rest of the guardians on the child. T8 wires the
   * call-site in `child.service.ts`.
   */
  abstract notifyGuardianSelfRevoked(
    event: GuardianSelfRevokedEvent,
  ): Promise<void>;

  // ── B11 Pickup OTP ─────────────────────────────────────────────────────

  /**
   * Fired after `sendOtp` dispatched the SMS to the trusted person.
   * Recipient: the requester user (typically the parent who initiated).
   */
  abstract notifyPickupOtpSent(event: PickupOtpSentEvent): Promise<void>;

  /**
   * Fired after `validateOtp` committed the check-out + pickup_request
   * transition. Recipients: the child's approved guardians + the requester.
   */
  abstract notifyPickupValidated(event: PickupValidatedEvent): Promise<void>;
}
