import { InvariantViolationError } from '../errors/invariant-violation.error';

export type GuardianStatusValue =
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'revoked';

// Sealed enum-VO mirroring DB enum `guardian_status`.
export class GuardianStatus {
  static readonly PENDING_APPROVAL = new GuardianStatus('pending_approval');
  static readonly APPROVED = new GuardianStatus('approved');
  static readonly REJECTED = new GuardianStatus('rejected');
  static readonly REVOKED = new GuardianStatus('revoked');

  private constructor(public readonly value: GuardianStatusValue) {}

  static fromString(v: string): GuardianStatus {
    switch (v) {
      case 'pending_approval':
        return GuardianStatus.PENDING_APPROVAL;
      case 'approved':
        return GuardianStatus.APPROVED;
      case 'rejected':
        return GuardianStatus.REJECTED;
      case 'revoked':
        return GuardianStatus.REVOKED;
      default:
        throw new InvariantViolationError(
          `guardian_status must be one of pending_approval|approved|rejected|revoked, got: ${v}`,
        );
    }
  }

  equals(other: GuardianStatus): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
