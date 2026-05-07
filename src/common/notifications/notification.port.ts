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

// ── B12 Parent-request events ──────────────────────────────────────────────

/**
 * Fired by `ParentRequestService.acceptRequest` after the conditional UPDATE
 * succeeded. Recipient: the parent who created the request (`requesterUserId`).
 * Nannies are excluded by the dispatcher's NANNY_ALLOWED_EVENT_KEYS gate.
 */
export interface ParentRequestAcceptedEvent {
  kindergartenId: string;
  parentRequestId: string;
  childId: string;
  requesterUserId: string;
  requestType: string;
  reviewedByStaffId: string;
}

/**
 * Fired by `ParentRequestService.rejectRequest`. Recipient: the parent who
 * created the request.
 */
export interface ParentRequestRejectedEvent {
  kindergartenId: string;
  parentRequestId: string;
  childId: string;
  requesterUserId: string;
  requestType: string;
  reviewedByStaffId: string;
}

/**
 * Fired by `ParentRequestService.cancelRequest` when the parent cancels a
 * pending request. Recipient: the staff member it was directed at (when
 * present); otherwise the dispatcher delivers to nobody.
 *
 * The producer pre-resolves `recipientStaffUserId` (staff_member.user_id) so
 * the dispatcher does not need a `StaffMemberRepository` dependency.
 */
export interface ParentRequestCancelledEvent {
  kindergartenId: string;
  parentRequestId: string;
  childId: string;
  requesterUserId: string;
  requestType: string;
  /** The staff_member id the request was addressed to, or null for `admin` recipientType. */
  recipientStaffId: string | null;
  /** Resolved user_id for the staff_member above; null when recipientStaffId is null. */
  recipientStaffUserId: string | null;
}

/**
 * Fired by `ParentRequestService.addParentMessage` / `addStaffMessage` when
 * a thread message is posted. Recipient resolution depends on `authorRole`:
 *   - parent author → staff (recipient_staff_id) when assigned
 *   - staff author → requester (parent)
 * Nannies are excluded by the nanny-policy gate.
 *
 * The producer pre-resolves `recipientStaffUserId` so the dispatcher does
 * not need a `StaffMemberRepository` dependency.
 */
export interface ParentRequestMessageSentEvent {
  kindergartenId: string;
  parentRequestId: string;
  childId: string;
  messageId: string;
  /** 'parent' if posted by the parent (requester); 'staff' if posted by a staff member. */
  authorRole: 'parent' | 'staff';
  /** Author user id (parent) or null when authored by staff. */
  authorUserId: string | null;
  /** Author staff_member id or null when authored by parent. */
  authorStaffId: string | null;
  /** Parent who created the parent_request (target when authorRole='staff'). */
  requesterUserId: string;
  /** Staff_member id this request was directed to (target when authorRole='parent'); null for `admin` recipientType. */
  recipientStaffId: string | null;
  /** Resolved user_id for `recipientStaffId`; null when no staff is assigned. */
  recipientStaffUserId: string | null;
}

// ── B13 Billing & Invoices events ──────────────────────────────────────────
//
// All eight events fan out to the child's approved-active guardians. The
// nanny-policy gate excludes role='nanny' guardians from `invoice.*`,
// `payment.*`, and `refund.*` keys (parent-app only — nannies see the
// attendance/pickup surface).
//
// Wire format on `notification_outbox.payload` is camelCase (matches the
// rest of the dispatcher). Display amounts/dates are rendered by the
// dispatcher templates from the typed fields here.

export interface NotifyInvoiceCreatedInput {
  kindergartenId: string;
  invoiceId: string;
  childId: string;
  invoiceType: string;
  amountAfterDiscount: number;
  /** ISO date `YYYY-MM-DD` (no time component). */
  dueDate: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface NotifyInvoicePaidInput {
  kindergartenId: string;
  invoiceId: string;
  childId: string;
  amountAfterDiscount: number;
  paidAt: Date;
}

export interface NotifyInvoiceOverdueInput {
  kindergartenId: string;
  invoiceId: string;
  childId: string;
  amountAfterDiscount: number;
  /** ISO date `YYYY-MM-DD`. */
  dueDate: string;
  daysOverdue: number;
}

export interface NotifyInvoiceCancelledInput {
  kindergartenId: string;
  invoiceId: string;
  childId: string;
  /** Free-form admin note; null if not captured. */
  reason: string | null;
}

export interface NotifyPaymentCompletedInput {
  kindergartenId: string;
  paymentId: string;
  childId: string;
  invoiceId: string;
  amount: number;
  provider: string;
  paidAt: Date;
}

export interface NotifyPaymentFailedInput {
  kindergartenId: string;
  paymentId: string;
  childId: string;
  invoiceId: string;
  amount: number;
  provider: string;
  failureReason: string;
}

export interface NotifyPaymentRefundedInput {
  kindergartenId: string;
  paymentId: string;
  childId: string;
  invoiceId: string;
  amount: number;
  refundId: string;
}

export interface NotifyRefundProcessedInput {
  kindergartenId: string;
  refundId: string;
  paymentId: string;
  childId: string;
  invoiceId: string;
  amount: number;
  processedBy: string;
}

/**
 * B16 — emitted by `CustomDiscountService.activate` when a discount with
 * `notify_on_activation=true` AND non-empty notification_title/body
 * transitions `draft → active`. Recipients are the child guardians of the
 * discount's resolved target set (resolved by the producer via
 * `DiscountTargetResolver` and pre-fanned-out to user_ids by the
 * dispatcher's `discount.activated` recipient resolver). BP §4.1: the
 * `expire` flow stays silent — only activation surfaces a parent ping.
 */
export interface NotifyDiscountActivatedInput {
  kindergartenId: string;
  discountId: string;
  /**
   * Localised name of the discount (snapshot, used in the notification
   * body when the admin omitted explicit notification copy).
   */
  discountName: Record<string, string>;
  /**
   * Pre-resolved set of children whose guardians should receive the
   * `discount.activated` event. The dispatcher's recipient resolver
   * fans out per-child guardians via a single multi-child query.
   */
  targetChildIds: string[];
  /**
   * Optional admin-supplied notification title / body in i18n shape.
   * When null, the dispatcher template falls back to a generic copy
   * keyed by the discount name.
   */
  notificationTitle: Record<string, string> | null;
  notificationBody: Record<string, string> | null;
}

// ── B18 Diagnostics & Progress events ─────────────────────────────────
//
// Both events fan out through the dispatcher's recipient resolvers
// (see `notification-dispatcher.service.ts` RECIPIENT_RESOLVERS):
//   - diagnostic.new      — guardians of the assessed child.
//   - progress_note.new   — guardians of the noted child.
// Neither key is in `NANNY_ALLOWED_EVENT_KEYS`, so nannies are dropped
// by the policy gate even when they are guardians.

export interface DiagnosticNewPayload {
  kindergartenId: string;
  childId: string;
  entryId: string;
  templateId: string;
  /** Snapshot of the template's display name at emit time. */
  templateName: string;
  specialistId: string;
  /** Snapshot of the template's specialist_type at emit time. */
  specialistType: string;
  /** ISO calendar date `YYYY-MM-DD`. */
  assessmentDate: string;
  createdAt: Date;
}

export interface ProgressNoteNewPayload {
  kindergartenId: string;
  childId: string;
  noteId: string;
  mentorId: string;
  notedAt: Date;
  createdAt: Date;
}

/**
 * T11 H6 — emitted by `EnrollmentService.transition` when the
 * `card_created` lax-mode catches a `TariffAssignmentNotFoundError`.
 * Recipients are the kindergarten's active admins (pre-resolved by the
 * producer via `StaffMemberRepository`). Without this admins had no
 * visible signal that the auto-generated first invoice was skipped — a
 * silent miss could lose a kindergarten weeks of billing.
 */
export interface NotifyEnrollmentFirstInvoiceSkippedInput {
  kindergartenId: string;
  enrollmentId: string;
  childId: string;
  reason: 'tariff_assignment_not_found';
  /**
   * Pre-resolved admin user_ids (NOT staff_member ids — the dispatcher
   * fans out by user_id). Producer reads these from
   * `StaffMemberRepository.listByKindergarten({role:'admin', isActive:true})`
   * before emitting.
   */
  recipientUserIds: string[];
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

  // ── B12 Parent-request events ──────────────────────────────────────────

  abstract notifyParentRequestAccepted(
    event: ParentRequestAcceptedEvent,
  ): Promise<void>;

  abstract notifyParentRequestRejected(
    event: ParentRequestRejectedEvent,
  ): Promise<void>;

  abstract notifyParentRequestCancelled(
    event: ParentRequestCancelledEvent,
  ): Promise<void>;

  abstract notifyParentRequestMessageSent(
    event: ParentRequestMessageSentEvent,
  ): Promise<void>;

  // ── B13 Billing & Invoices ──────────────────────────────────────────────

  abstract notifyInvoiceCreated(
    event: NotifyInvoiceCreatedInput,
  ): Promise<void>;

  abstract notifyInvoicePaid(event: NotifyInvoicePaidInput): Promise<void>;

  abstract notifyInvoiceOverdue(
    event: NotifyInvoiceOverdueInput,
  ): Promise<void>;

  abstract notifyInvoiceCancelled(
    event: NotifyInvoiceCancelledInput,
  ): Promise<void>;

  abstract notifyPaymentCompleted(
    event: NotifyPaymentCompletedInput,
  ): Promise<void>;

  abstract notifyPaymentFailed(event: NotifyPaymentFailedInput): Promise<void>;

  abstract notifyPaymentRefunded(
    event: NotifyPaymentRefundedInput,
  ): Promise<void>;

  abstract notifyRefundProcessed(
    event: NotifyRefundProcessedInput,
  ): Promise<void>;

  abstract notifyEnrollmentFirstInvoiceSkipped(
    event: NotifyEnrollmentFirstInvoiceSkippedInput,
  ): Promise<void>;

  // ── B16 Custom Discounts ──────────────────────────────────────────────
  // Non-abstract default-no-op so older test FakeNotificationPort classes
  // (B7..B13 specs) keep compiling. Production adapters
  // (`OutboxNotificationAdapter`, `InMemoryNotificationAdapter`)
  // override with the real fan-out.

  /**
   * Fired by `CustomDiscountService.activate` when the discount has
   * `notify_on_activation=true`. The dispatcher's `discount.activated`
   * recipient resolver fans out to the children's approved guardians
   * (parents only — `discount.*` is not in `NANNY_ALLOWED_EVENT_KEYS`).
   */
  notifyDiscountActivated(_event: NotifyDiscountActivatedInput): Promise<void> {
    return Promise.resolve();
  }

  // ── B18 Diagnostics & Progress ──────────────────────────────────────
  // Non-abstract default-no-op so older test FakeNotificationPort classes
  // keep compiling. Production `OutboxNotificationAdapter` overrides;
  // `InMemoryNotificationAdapter` records into its events array.

  /**
   * Fired by `DiagnosticEntryService.create` after a specialist authors a
   * new entry. Recipients: approved-active guardians of the assessed
   * child (parents only — `diagnostic.*` is NOT in NANNY_ALLOWED_EVENT_KEYS).
   */
  notifyDiagnosticNew(_event: DiagnosticNewPayload): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Fired by `ProgressNoteService.create` after a mentor logs a new note.
   * Recipients: approved-active guardians of the noted child (parents only).
   */
  notifyProgressNoteNew(_event: ProgressNoteNewPayload): Promise<void> {
    return Promise.resolve();
  }
}
