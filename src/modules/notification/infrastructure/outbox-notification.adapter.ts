import { Injectable } from '@nestjs/common';
import {
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  GuardianSelfRevokedEvent,
  NotificationPort,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
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
    return this.enqueue(event.kindergartenId, 'child.transferred', {
      childId: event.childId,
      fromGroupId: event.fromGroupId,
      toGroupId: event.toGroupId,
      transferredBy: event.transferredBy,
      recipientUserIds: event.recipientUserIds,
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
