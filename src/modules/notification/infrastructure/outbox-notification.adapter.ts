import { Injectable } from '@nestjs/common';
import {
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildArchivedEvent,
  ChildReactivatedEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  DiagnosticNewPayload,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  GuardianSelfRevokedEvent,
  NotificationPort,
  NotifyContentBirthdayInput,
  NotifyContentNewsPublishedInput,
  NotifyContentQundylyqNewInput,
  NotifyContentStoryNewInput,
  NotifyDiscountActivatedInput,
  NotifyEnrollmentFirstInvoiceSkippedInput,
  NotifyInvoiceCancelledInput,
  NotifyInvoiceCreatedInput,
  NotifyInvoiceOverdueInput,
  NotifyInvoicePaidInput,
  NotifyKaspiSessionExpiredInput,
  NotifyPaymentCompletedInput,
  NotifyPaymentFailedInput,
  NotifyPaymentRefundedInput,
  NotifyPaymentRefundRequiredInput,
  NotifyRefundProcessedInput,
  ParentRequestAcceptedEvent,
  ParentRequestCancelledEvent,
  ParentRequestMessageSentEvent,
  ParentRequestRejectedEvent,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
  ProgressNoteNewPayload,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { tenantStorage } from '@/database/tenant-storage';
import { OutboxEventRepository } from '../outbox-event.repository';

/**
 * OutboxNotificationAdapter — production binding for `NotificationPort`.
 *
 * Each port method serialises the typed payload into a JSON-safe object and
 * inserts a row into `notification_outbox` via `OutboxEventRepository.enqueue`.
 * The repository picks up the calling business transaction's `EntityManager`
 * from `tenantStorage` automatically — that's how the outbox row is
 * committed atomically with the business mutation that triggered it. No
 * inner transaction is opened here; if `tenantStorage` is empty the
 * repository falls through to its own connection-level manager (used by
 * non-HTTP scripts and select integration tests).
 *
 * Event-key mapping (canonical):
 *   notifyGuardianPendingApproval → guardian.pending_approval
 *   notifyGuardianApproved        → guardian.approved
 *   notifyGuardianRejected        → guardian.rejected
 *   notifyGuardianRevoked         → guardian.revoked
 *   notifyGuardianSelfRevoked     → guardian.self_revoked
 *   notifyChildTransferred        → child.transferred
 *   notifyPermissionsUpdated      → guardian.permissions_updated
 *   notifyAttendanceCheckIn       → attendance.checkin
 *   notifyAttendanceCheckOut      → attendance.checkout
 *   notifyDailyStatusChanged      → daily_status.changed
 *   notifyTimelineEntryCreated    → timeline.entry_created
 *
 * Dates are serialised to ISO-8601 strings — JSONB cannot represent the JS
 * `Date` type natively, and the dispatcher needs string-only `data`-fields
 * for the FCM contract anyway.
 */
@Injectable()
export class OutboxNotificationAdapter extends NotificationPort {
  constructor(private readonly outboxRepo: OutboxEventRepository) {
    super();
  }

  notifyGuardianPendingApproval(
    event: GuardianPendingApprovalEvent,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'guardian.pending_approval', {
      childId: event.childId,
      childFullName: event.childFullName,
      primaryUserId: event.primaryUserId,
      requesterUserId: event.requesterUserId,
      role: event.role,
    });
  }

  notifyGuardianApproved(event: GuardianApprovedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'guardian.approved', {
      childId: event.childId,
      guardianUserId: event.guardianUserId,
      approvedBy: event.approvedBy,
      hasApprovalRights: event.hasApprovalRights,
    });
  }

  notifyGuardianRejected(event: GuardianRejectedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'guardian.rejected', {
      childId: event.childId,
      guardianUserId: event.guardianUserId,
      rejectedBy: event.rejectedBy,
    });
  }

  notifyGuardianRevoked(event: GuardianRevokedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'guardian.revoked', {
      childId: event.childId,
      guardianUserId: event.guardianUserId,
      revokedBy: event.revokedBy,
    });
  }

  notifyGuardianSelfRevoked(event: GuardianSelfRevokedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'guardian.self_revoked', {
      childId: event.childId,
      userId: event.userId,
      revokedAt: event.revokedAt.toISOString(),
    });
  }

  notifyChildTransferred(event: ChildTransferredEvent): Promise<void> {
    // M5 (B22a): `recipientUserIds` is intentionally NOT persisted in the
    // outbox payload. The dispatcher resolves recipients via
    // `resolveByChildGuardians` at delivery time (see
    // notification-dispatcher.service.ts), so the upstream-resolved list is
    // dead-code data here AND a PII leak — `notification_outbox` is
    // admin-readable. The producer (ChildService) still computes the list
    // for its own auditing flow but it does not need to round-trip via the
    // outbox row. Contrast with `enrollment.first_invoice_skipped` which
    // DOES require `recipientUserIds` in payload because its resolver is
    // `resolveRecipientUserIdsFromPayload` (no module dependency on staff).
    return this.enqueue(event.kindergartenId, 'child.transferred', {
      childId: event.childId,
      fromGroupId: event.fromGroupId,
      toGroupId: event.toGroupId,
      transferredBy: event.transferredBy,
    });
  }

  notifyPermissionsUpdated(event: PermissionsUpdatedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'guardian.permissions_updated', {
      childId: event.childId,
      guardianUserId: event.guardianUserId,
      updatedBy: event.updatedBy,
      effectivePermissions: event.effectivePermissions,
    });
  }

  notifyAttendanceCheckIn(event: AttendanceCheckInEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'attendance.checkin', {
      childId: event.childId,
      eventId: event.eventId,
      recordedAt: event.recordedAt.toISOString(),
      recordedByStaffMemberId: event.recordedByStaffMemberId,
    });
  }

  notifyAttendanceCheckOut(event: AttendanceCheckOutEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'attendance.checkout', {
      childId: event.childId,
      eventId: event.eventId,
      recordedAt: event.recordedAt.toISOString(),
      recordedByStaffMemberId: event.recordedByStaffMemberId,
      pickupUserId: event.pickupUserId,
      pickupRequestId: event.pickupRequestId,
    });
  }

  notifyDailyStatusChanged(event: DailyStatusChangedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'daily_status.changed', {
      childId: event.childId,
      date: event.date,
      status: event.status,
      setByStaffMemberId: event.setByStaffMemberId,
    });
  }

  notifyTimelineEntryCreated(event: TimelineEntryCreatedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'timeline.entry_created', {
      childId: event.childId,
      entryId: event.entryId,
      entryType: event.entryType,
      entryTime: event.entryTime.toISOString(),
      recordedByStaffMemberId: event.recordedByStaffMemberId,
    });
  }

  notifyPickupOtpSent(event: PickupOtpSentEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'pickup.otp_sent', {
      childId: event.childId,
      pickupRequestId: event.pickupRequestId,
      requesterUserId: event.requesterUserId,
      trustedPersonName: event.trustedPersonName,
    });
  }

  notifyPickupValidated(event: PickupValidatedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'pickup.validated', {
      childId: event.childId,
      pickupRequestId: event.pickupRequestId,
      requesterUserId: event.requesterUserId,
      trustedPersonName: event.trustedPersonName,
      attendanceEventId: event.attendanceEventId,
      validatedAt: event.validatedAt.toISOString(),
    });
  }

  // ── B12 Parent-request events ────────────────────────────────────────────

  notifyParentRequestAccepted(
    event: ParentRequestAcceptedEvent,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'request.accepted', {
      parentRequestId: event.parentRequestId,
      childId: event.childId,
      requesterUserId: event.requesterUserId,
      requestType: event.requestType,
      reviewedByStaffId: event.reviewedByStaffId,
    });
  }

  notifyParentRequestRejected(
    event: ParentRequestRejectedEvent,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'request.rejected', {
      parentRequestId: event.parentRequestId,
      childId: event.childId,
      requesterUserId: event.requesterUserId,
      requestType: event.requestType,
      reviewedByStaffId: event.reviewedByStaffId,
    });
  }

  notifyParentRequestCancelled(
    event: ParentRequestCancelledEvent,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'request.cancelled', {
      parentRequestId: event.parentRequestId,
      childId: event.childId,
      requesterUserId: event.requesterUserId,
      requestType: event.requestType,
      recipientStaffId: event.recipientStaffId,
      recipientStaffUserId: event.recipientStaffUserId,
    });
  }

  notifyParentRequestMessageSent(
    event: ParentRequestMessageSentEvent,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'request.message_sent', {
      parentRequestId: event.parentRequestId,
      childId: event.childId,
      messageId: event.messageId,
      authorRole: event.authorRole,
      authorUserId: event.authorUserId,
      authorStaffId: event.authorStaffId,
      requesterUserId: event.requesterUserId,
      recipientStaffId: event.recipientStaffId,
      recipientStaffUserId: event.recipientStaffUserId,
    });
  }

  // ── B13 Billing & Invoices events ──────────────────────────────────────

  notifyInvoiceCreated(event: NotifyInvoiceCreatedInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'invoice.created', {
      invoiceId: event.invoiceId,
      childId: event.childId,
      invoiceType: event.invoiceType,
      amountAfterDiscount: event.amountAfterDiscount,
      dueDate: event.dueDate,
      periodStart: event.periodStart.toISOString(),
      periodEnd: event.periodEnd.toISOString(),
    });
  }

  notifyInvoicePaid(event: NotifyInvoicePaidInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'invoice.paid', {
      invoiceId: event.invoiceId,
      childId: event.childId,
      amountAfterDiscount: event.amountAfterDiscount,
      paidAt: event.paidAt.toISOString(),
    });
  }

  notifyInvoiceOverdue(event: NotifyInvoiceOverdueInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'invoice.overdue', {
      invoiceId: event.invoiceId,
      childId: event.childId,
      amountAfterDiscount: event.amountAfterDiscount,
      dueDate: event.dueDate,
      daysOverdue: event.daysOverdue,
    });
  }

  notifyInvoiceCancelled(event: NotifyInvoiceCancelledInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'invoice.cancelled', {
      invoiceId: event.invoiceId,
      childId: event.childId,
      reason: event.reason,
    });
  }

  notifyPaymentCompleted(event: NotifyPaymentCompletedInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'payment.completed', {
      paymentId: event.paymentId,
      childId: event.childId,
      invoiceId: event.invoiceId,
      amount: event.amount,
      provider: event.provider,
      paidAt: event.paidAt.toISOString(),
    });
  }

  notifyPaymentFailed(event: NotifyPaymentFailedInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'payment.failed', {
      paymentId: event.paymentId,
      childId: event.childId,
      invoiceId: event.invoiceId,
      amount: event.amount,
      provider: event.provider,
      failureReason: event.failureReason,
    });
  }

  notifyPaymentRefunded(event: NotifyPaymentRefundedInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'payment.refunded', {
      paymentId: event.paymentId,
      childId: event.childId,
      invoiceId: event.invoiceId,
      amount: event.amount,
      refundId: event.refundId,
    });
  }

  notifyRefundProcessed(event: NotifyRefundProcessedInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'refund.processed', {
      refundId: event.refundId,
      paymentId: event.paymentId,
      childId: event.childId,
      invoiceId: event.invoiceId,
      amount: event.amount,
      processedBy: event.processedBy,
    });
  }

  notifyEnrollmentFirstInvoiceSkipped(
    event: NotifyEnrollmentFirstInvoiceSkippedInput,
  ): Promise<void> {
    return this.enqueue(
      event.kindergartenId,
      'enrollment.first_invoice_skipped',
      {
        enrollmentId: event.enrollmentId,
        childId: event.childId,
        reason: event.reason,
        recipientUserIds: event.recipientUserIds,
      },
    );
  }

  // ── B16 Custom Discounts ──────────────────────────────────────────────

  notifyDiscountActivated(event: NotifyDiscountActivatedInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'discount.activated', {
      discountId: event.discountId,
      discountName: event.discountName,
      targetChildIds: event.targetChildIds,
      notificationTitle: event.notificationTitle,
      notificationBody: event.notificationBody,
    });
  }

  // ── B18 Diagnostics & Progress ────────────────────────────────────────

  notifyDiagnosticNew(event: DiagnosticNewPayload): Promise<void> {
    return this.enqueue(event.kindergartenId, 'diagnostic.new', {
      childId: event.childId,
      entryId: event.entryId,
      templateId: event.templateId,
      templateName: event.templateName,
      specialistId: event.specialistId,
      specialistType: event.specialistType,
      assessmentDate: event.assessmentDate,
      createdAt: event.createdAt.toISOString(),
    });
  }

  notifyProgressNoteNew(event: ProgressNoteNewPayload): Promise<void> {
    return this.enqueue(event.kindergartenId, 'progress_note.new', {
      childId: event.childId,
      noteId: event.noteId,
      mentorId: event.mentorId,
      notedAt: event.notedAt.toISOString(),
      createdAt: event.createdAt.toISOString(),
    });
  }

  // ── B17 Content & Stories ──────────────────────────────────────────────

  notifyContentNewsPublished(
    event: NotifyContentNewsPublishedInput,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'content.news_published', {
      contentPostId: event.contentPostId,
      targetType: event.targetType,
      targetGroupId: event.targetGroupId,
      targetChildId: event.targetChildId,
      titleI18n: event.titleI18n,
      publishedAt: event.publishedAt.toISOString(),
    });
  }

  notifyContentStoryNew(event: NotifyContentStoryNewInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'content.story_new', {
      storyId: event.storyId,
      groupId: event.groupId,
      mediaUrl: event.mediaUrl,
      mediaType: event.mediaType,
      createdBy: event.createdBy,
      createdAt: event.createdAt.toISOString(),
    });
  }

  notifyContentQundylyqNew(
    event: NotifyContentQundylyqNewInput,
  ): Promise<void> {
    return this.enqueue(event.kindergartenId, 'content.qundylyq_new', {
      contentPostId: event.contentPostId,
      titleI18n: event.titleI18n,
      metadata: event.metadata,
      publishedAt: event.publishedAt.toISOString(),
    });
  }

  notifyContentBirthday(event: NotifyContentBirthdayInput): Promise<void> {
    return this.enqueue(event.kindergartenId, 'content.birthday', {
      contentPostId: event.contentPostId,
      targetChildId: event.targetChildId,
      childFullName: event.childFullName,
      age: event.age,
      publishedAt: event.publishedAt.toISOString(),
    });
  }

  // ── B21 Child lifecycle events ─────────────────────────────────────────

  notifyChildArchived(event: ChildArchivedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'child.archived', {
      childId: event.childId,
      archivedAt: event.archivedAt.toISOString(),
      archiveReason: event.archiveReason,
      archivedByStaffId: event.archivedByStaffId,
    });
  }

  notifyChildReactivated(event: ChildReactivatedEvent): Promise<void> {
    return this.enqueue(event.kindergartenId, 'child.reactivated', {
      childId: event.childId,
      reactivatedAt: event.reactivatedAt.toISOString(),
      reactivatedByStaffId: event.reactivatedByStaffId,
    });
  }

  // ── B24 Kaspi Pay ──────────────────────────────────────────────────────

  notifyKaspiSessionExpired(
    event: NotifyKaspiSessionExpiredInput,
  ): Promise<void> {
    // Recipients resolved from the payload (admin user_ids) by the
    // dispatcher's `resolveRecipientUserIdsFromPayload` — same pattern as
    // `enrollment.first_invoice_skipped`. No PII / payment context carried.
    return this.enqueue(event.kindergartenId, 'kaspi.session_expired', {
      recipientUserIds: event.recipientUserIds,
    });
  }

  notifyPaymentRefundRequired(
    event: NotifyPaymentRefundRequiredInput,
  ): Promise<void> {
    // #5b — recipients are pre-resolved kg admins, fanned out by the
    // dispatcher's `resolveRecipientUserIdsFromPayload` (mirrors
    // `kaspi.session_expired`). Carries the duplicate + kept payment ids so
    // the admin app can deep-link both.
    return this.enqueue(event.kindergartenId, 'payment.refund_required', {
      paymentId: event.paymentId,
      duplicateOfPaymentId: event.duplicateOfPaymentId,
      invoiceId: event.invoiceId,
      childId: event.childId,
      amount: event.amount,
      reason: event.reason,
      recipientUserIds: event.recipientUserIds,
    });
  }

  private async enqueue(
    kindergartenId: string,
    eventKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const manager = tenantStorage.getStore()?.entityManager;
    await this.outboxRepo.enqueue(
      { kindergartenId, eventKey, payload },
      manager,
    );
  }
}
