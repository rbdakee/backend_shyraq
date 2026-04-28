import { StaffMember, StaffRole } from './domain/entities/staff-member.entity';
import { SpecialistType } from './domain/value-objects/specialist-type.vo';

export interface CreateStaffMemberInput {
  kindergartenId: string;
  userId: string;
  fullName?: string | null;
  phone?: string | null;
  role: StaffRole;
  specialistType?: SpecialistType | null;
  hiredAt?: Date | null;
}

export interface UpdateStaffMemberInput {
  fullName?: string | null;
  role?: StaffRole;
  specialistType?: SpecialistType | null;
  hiredAt?: Date | null;
  firedAt?: Date | null;
}

export interface ListStaffFilters {
  role?: StaffRole;
  isActive?: boolean;
  specialistType?: SpecialistType;
  archived?: boolean;
  search?: string;
}

/**
 * Port over the staff_members table. Implementations are tenant-aware via
 * `tenantStorage` — readers transparently use the request's transactional
 * EntityManager so RLS GUCs apply, while SuperAdmin paths set
 * `bypass_rls=true` upstream.
 */
export abstract class StaffMemberRepository {
  /**
   * Inserts a new staff_members row. Honors the partial unique index
   * `(kindergarten_id, user_id) WHERE is_active = true`: a duplicate active
   * pair surfaces as `StaffAlreadyExistsError`.
   */
  abstract create(input: CreateStaffMemberInput): Promise<StaffMember>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<StaffMember | null>;

  abstract findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null>;

  abstract listByKindergarten(
    kindergartenId: string,
    filters?: ListStaffFilters,
  ): Promise<StaffMember[]>;

  abstract update(
    kindergartenId: string,
    id: string,
    changes: UpdateStaffMemberInput,
  ): Promise<StaffMember | null>;

  /**
   * Replace the persisted state of a hydrated StaffMember (used by the
   * service after applying domain mutations: archive/restore/transfer).
   */
  abstract save(staffMember: StaffMember): Promise<StaffMember>;

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
