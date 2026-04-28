import { StaffMember, StaffRole } from './domain/entities/staff-member.entity';

export interface CreateStaffMemberInput {
  kindergartenId: string;
  userId: string;
  role: StaffRole;
  specialistType?: string | null;
  hiredAt?: Date | null;
}

/**
 * Port over staff_members. P3 only exposes a minimum surface — enough for
 * createKindergarten to seed the first admin row and for archiveCascade to
 * deactivate every staff row of a soft-deleted kindergarten. The full
 * contract (list / update / assignToGroup / etc.) is deferred to P4.
 */
export abstract class StaffMemberRepository {
  /**
   * Inserts a new staff_members row. Honors the partial unique index
   * `(kindergarten_id, user_id) WHERE is_active = true`: a duplicate active
   * pair surfaces as `StaffAlreadyExistsError`.
   */
  abstract create(input: CreateStaffMemberInput): Promise<StaffMember>;

  abstract findById(id: string): Promise<StaffMember | null>;

  abstract findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null>;

  abstract listByKindergarten(kindergartenId: string): Promise<StaffMember[]>;

  /**
   * Bulk deactivate every active row of a kindergarten. Used by
   * archiveKindergarten — sets is_active=false + fired_at=now.
   * Returns the number of affected rows.
   */
  abstract deactivateAllByKindergarten(
    kindergartenId: string,
    now: Date,
  ): Promise<number>;
}
