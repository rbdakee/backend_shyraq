import { Injectable, Logger } from '@nestjs/common';
import {
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  NotificationPort,
  PermissionsUpdatedEvent,
  TimelineEntryCreatedEvent,
} from './notification.port';

/**
 * Logging-only adapter for the NotificationPort. Each method emits a single
 * `Logger.log` line with the event payload as structured metadata. Real
 * adapters (push, email, in-app) can be swapped in later without changing
 * any call-site.
 */
@Injectable()
export class LoggingNotificationAdapter extends NotificationPort {
  private readonly logger = new Logger('Notification');

  notifyGuardianPendingApproval(
    event: GuardianPendingApprovalEvent,
  ): Promise<void> {
    this.logger.log({ type: 'guardian_pending_approval', ...event });
    return Promise.resolve();
  }

  notifyGuardianApproved(event: GuardianApprovedEvent): Promise<void> {
    this.logger.log({ type: 'guardian_approved', ...event });
    return Promise.resolve();
  }

  notifyGuardianRejected(event: GuardianRejectedEvent): Promise<void> {
    this.logger.log({ type: 'guardian_rejected', ...event });
    return Promise.resolve();
  }

  notifyGuardianRevoked(event: GuardianRevokedEvent): Promise<void> {
    this.logger.log({ type: 'guardian_revoked', ...event });
    return Promise.resolve();
  }

  notifyChildTransferred(event: ChildTransferredEvent): Promise<void> {
    this.logger.log({ type: 'child_transferred', ...event });
    return Promise.resolve();
  }

  notifyPermissionsUpdated(event: PermissionsUpdatedEvent): Promise<void> {
    this.logger.log({ type: 'permissions_updated', ...event });
    return Promise.resolve();
  }

  // ── B8 Attendance & Timeline ───────────────────────────────────────────

  notifyAttendanceCheckIn(event: AttendanceCheckInEvent): Promise<void> {
    this.logger.log({ type: 'attendance_check_in', ...event });
    // TODO(B9): WS fanout — resolve recipients via
    // ChildGuardianRepository.findApprovedGuardians +
    // NotificationPreferenceRepository.filterByChannel.
    return Promise.resolve();
  }

  notifyAttendanceCheckOut(event: AttendanceCheckOutEvent): Promise<void> {
    this.logger.log({ type: 'attendance_check_out', ...event });
    // TODO(B9): WS fanout — resolve recipients via
    // ChildGuardianRepository.findApprovedGuardians +
    // NotificationPreferenceRepository.filterByChannel.
    return Promise.resolve();
  }

  notifyDailyStatusChanged(event: DailyStatusChangedEvent): Promise<void> {
    this.logger.log({ type: 'daily_status_changed', ...event });
    // TODO(B9): WS fanout — resolve recipients via
    // ChildGuardianRepository.findApprovedGuardians +
    // NotificationPreferenceRepository.filterByChannel.
    return Promise.resolve();
  }

  notifyTimelineEntryCreated(event: TimelineEntryCreatedEvent): Promise<void> {
    this.logger.log({ type: 'timeline_entry_created', ...event });
    // TODO(B9): WS fanout — resolve recipients via
    // ChildGuardianRepository.findApprovedGuardians +
    // NotificationPreferenceRepository.filterByChannel.
    return Promise.resolve();
  }
}
