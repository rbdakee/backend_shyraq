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
}
