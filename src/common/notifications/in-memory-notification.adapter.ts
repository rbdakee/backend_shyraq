import { Injectable, Logger } from '@nestjs/common';
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
} from './notification.port';

/**
 * In-memory `NotificationPort` implementation used by integration tests and
 * service-unit tests that exercise modules whose call-graph hits a notify*
 * method. Each invocation is logged AND captured in a typed-event list.
 *
 * NOT wired in production. The production adapter lives in
 * `src/modules/notification/infrastructure/outbox-notification.adapter.ts`
 * (`OutboxNotificationAdapter`) and enqueues to `notification_outbox` instead
 * of logging. This file is the renamed successor of the old
 * `LoggingNotificationAdapter` — kept around because integration suites that
 * spin up service.ts modules without the full `NotificationModule` need a
 * working port stub.
 */
@Injectable()
export class InMemoryNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('Notification');
  readonly events: Array<{ type: string; event: unknown }> = [];

  notifyGuardianPendingApproval(
    event: GuardianPendingApprovalEvent,
  ): Promise<void> {
    this.record('guardian_pending_approval', event);
    return Promise.resolve();
  }

  notifyGuardianApproved(event: GuardianApprovedEvent): Promise<void> {
    this.record('guardian_approved', event);
    return Promise.resolve();
  }

  notifyGuardianRejected(event: GuardianRejectedEvent): Promise<void> {
    this.record('guardian_rejected', event);
    return Promise.resolve();
  }

  notifyGuardianRevoked(event: GuardianRevokedEvent): Promise<void> {
    this.record('guardian_revoked', event);
    return Promise.resolve();
  }

  notifyChildTransferred(event: ChildTransferredEvent): Promise<void> {
    this.record('child_transferred', event);
    return Promise.resolve();
  }

  notifyPermissionsUpdated(event: PermissionsUpdatedEvent): Promise<void> {
    this.record('permissions_updated', event);
    return Promise.resolve();
  }

  notifyAttendanceCheckIn(event: AttendanceCheckInEvent): Promise<void> {
    this.record('attendance_check_in', event);
    return Promise.resolve();
  }

  notifyAttendanceCheckOut(event: AttendanceCheckOutEvent): Promise<void> {
    this.record('attendance_check_out', event);
    return Promise.resolve();
  }

  notifyDailyStatusChanged(event: DailyStatusChangedEvent): Promise<void> {
    this.record('daily_status_changed', event);
    return Promise.resolve();
  }

  notifyTimelineEntryCreated(event: TimelineEntryCreatedEvent): Promise<void> {
    this.record('timeline_entry_created', event);
    return Promise.resolve();
  }

  notifyGuardianSelfRevoked(event: GuardianSelfRevokedEvent): Promise<void> {
    this.record('guardian_self_revoked', event);
    return Promise.resolve();
  }

  notifyPickupOtpSent(event: PickupOtpSentEvent): Promise<void> {
    this.record('pickup_otp_sent', event);
    return Promise.resolve();
  }

  notifyPickupValidated(event: PickupValidatedEvent): Promise<void> {
    this.record('pickup_validated', event);
    return Promise.resolve();
  }

  notifyParentRequestAccepted(
    event: ParentRequestAcceptedEvent,
  ): Promise<void> {
    this.record('parent_request_accepted', event);
    return Promise.resolve();
  }

  notifyParentRequestRejected(
    event: ParentRequestRejectedEvent,
  ): Promise<void> {
    this.record('parent_request_rejected', event);
    return Promise.resolve();
  }

  notifyParentRequestCancelled(
    event: ParentRequestCancelledEvent,
  ): Promise<void> {
    this.record('parent_request_cancelled', event);
    return Promise.resolve();
  }

  notifyParentRequestMessageSent(
    event: ParentRequestMessageSentEvent,
  ): Promise<void> {
    this.record('parent_request_message_sent', event);
    return Promise.resolve();
  }

  // ── B13 Billing & Invoices events ──────────────────────────────────────

  notifyInvoiceCreated(event: NotifyInvoiceCreatedInput): Promise<void> {
    this.record('invoice_created', event);
    return Promise.resolve();
  }

  notifyInvoicePaid(event: NotifyInvoicePaidInput): Promise<void> {
    this.record('invoice_paid', event);
    return Promise.resolve();
  }

  notifyInvoiceOverdue(event: NotifyInvoiceOverdueInput): Promise<void> {
    this.record('invoice_overdue', event);
    return Promise.resolve();
  }

  notifyInvoiceCancelled(event: NotifyInvoiceCancelledInput): Promise<void> {
    this.record('invoice_cancelled', event);
    return Promise.resolve();
  }

  notifyPaymentCompleted(event: NotifyPaymentCompletedInput): Promise<void> {
    this.record('payment_completed', event);
    return Promise.resolve();
  }

  notifyPaymentFailed(event: NotifyPaymentFailedInput): Promise<void> {
    this.record('payment_failed', event);
    return Promise.resolve();
  }

  notifyPaymentRefunded(event: NotifyPaymentRefundedInput): Promise<void> {
    this.record('payment_refunded', event);
    return Promise.resolve();
  }

  notifyRefundProcessed(event: NotifyRefundProcessedInput): Promise<void> {
    this.record('refund_processed', event);
    return Promise.resolve();
  }

  notifyEnrollmentFirstInvoiceSkipped(
    event: NotifyEnrollmentFirstInvoiceSkippedInput,
  ): Promise<void> {
    this.record('enrollment_first_invoice_skipped', event);
    return Promise.resolve();
  }

  notifyDiscountActivated(event: NotifyDiscountActivatedInput): Promise<void> {
    this.record('discount_activated', event);
    return Promise.resolve();
  }

  // ── B18 Diagnostics & Progress events ─────────────────────────────────

  notifyDiagnosticNew(event: DiagnosticNewPayload): Promise<void> {
    this.record('diagnostic_new', event);
    return Promise.resolve();
  }

  notifyProgressNoteNew(event: ProgressNoteNewPayload): Promise<void> {
    this.record('progress_note_new', event);
    return Promise.resolve();
  }

  // ── B17 Content & Stories events ──────────────────────────────────────

  notifyContentNewsPublished(
    event: NotifyContentNewsPublishedInput,
  ): Promise<void> {
    this.record('content_news_published', event);
    return Promise.resolve();
  }

  notifyContentStoryNew(event: NotifyContentStoryNewInput): Promise<void> {
    this.record('content_story_new', event);
    return Promise.resolve();
  }

  notifyContentQundylyqNew(
    event: NotifyContentQundylyqNewInput,
  ): Promise<void> {
    this.record('content_qundylyq_new', event);
    return Promise.resolve();
  }

  notifyContentBirthday(event: NotifyContentBirthdayInput): Promise<void> {
    this.record('content_birthday', event);
    return Promise.resolve();
  }

  // ── B21 Child lifecycle events ────────────────────────────────────────

  notifyChildArchived(event: ChildArchivedEvent): Promise<void> {
    this.record('child_archived', event);
    return Promise.resolve();
  }

  notifyChildReactivated(event: ChildReactivatedEvent): Promise<void> {
    this.record('child_reactivated', event);
    return Promise.resolve();
  }

  // ── B24 Kaspi Pay events ──────────────────────────────────────────────

  notifyKaspiSessionExpired(
    event: NotifyKaspiSessionExpiredInput,
  ): Promise<void> {
    this.record('kaspi_session_expired', event);
    return Promise.resolve();
  }

  notifyPaymentRefundRequired(
    event: NotifyPaymentRefundRequiredInput,
  ): Promise<void> {
    this.record('payment_refund_required', event);
    return Promise.resolve();
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private record(type: string, event: unknown): void {
    this.logger.log({ type, ...(event as Record<string, unknown>) });
    this.events.push({ type, event });
  }
}
