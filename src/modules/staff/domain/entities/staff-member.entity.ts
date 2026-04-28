import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  isSpecialistType,
  SpecialistType,
} from '../value-objects/specialist-type.vo';

export type StaffRole = 'admin' | 'mentor' | 'specialist' | 'reception';

const ROLE_VALUES: readonly StaffRole[] = [
  'admin',
  'mentor',
  'specialist',
  'reception',
];

export interface StaffMemberState {
  id: string;
  kindergartenId: string;
  userId: string;
  fullName: string | null;
  phone: string | null;
  role: StaffRole;
  specialistType: SpecialistType | null;
  isActive: boolean;
  hiredAt: Date | null;
  firedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * StaffMember domain entity. Holds the role × specialist-type matrix
 * invariant and the lifecycle flags (active / archived). Mutators return
 * `this` after applying the change, so the service layer can chain them
 * before persisting; persistence layer reads the new state via `toState()`.
 *
 * Invariants enforced:
 *   - role ∈ {admin, mentor, specialist, reception}
 *   - role=specialist requires a non-null specialist_type from the whitelist
 *   - role≠specialist forbids specialist_type
 */
export class StaffMember {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly userId: string,
    private _fullName: string | null,
    private _phone: string | null,
    private _role: StaffRole,
    private _specialistType: SpecialistType | null,
    private _isActive: boolean,
    private _hiredAt: Date | null,
    private _firedAt: Date | null,
    private _archivedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: StaffMemberState): StaffMember {
    StaffMember.validateRole(state.role);
    StaffMember.validateRoleMatrix(state.role, state.specialistType);
    return new StaffMember(
      state.id,
      state.kindergartenId,
      state.userId,
      state.fullName,
      state.phone,
      state.role,
      state.specialistType,
      state.isActive,
      state.hiredAt,
      state.firedAt,
      state.archivedAt,
      state.createdAt,
      state.updatedAt,
    );
  }

  static validateRole(role: StaffRole): void {
    if (!ROLE_VALUES.includes(role)) {
      throw new InvariantViolationError(
        `staff role must be one of: ${ROLE_VALUES.join(', ')}`,
      );
    }
  }

  /**
   * Enforces the role × specialist_type matrix.
   *   - role=specialist must carry a whitelisted specialist_type.
   *   - role∈{admin, mentor, reception} must carry specialist_type=null.
   */
  static validateRoleMatrix(
    role: StaffRole,
    specialistType: SpecialistType | null | undefined,
  ): void {
    if (role === 'specialist') {
      if (specialistType === null || specialistType === undefined) {
        throw new InvariantViolationError(
          `role=specialist requires specialist_type`,
        );
      }
      if (!isSpecialistType(specialistType)) {
        throw new InvariantViolationError(
          `invalid specialist_type: ${String(specialistType)}`,
        );
      }
      return;
    }
    if (specialistType !== null && specialistType !== undefined) {
      throw new InvariantViolationError(`role=${role} forbids specialist_type`);
    }
  }

  // ── getters ─────────────────────────────────────────────────────────────

  get fullName(): string | null {
    return this._fullName;
  }
  get phone(): string | null {
    return this._phone;
  }
  get role(): StaffRole {
    return this._role;
  }
  get specialistType(): SpecialistType | null {
    return this._specialistType;
  }
  get isActive(): boolean {
    return this._isActive;
  }
  get hiredAt(): Date | null {
    return this._hiredAt;
  }
  get firedAt(): Date | null {
    return this._firedAt;
  }
  get archivedAt(): Date | null {
    return this._archivedAt;
  }
  get isArchived(): boolean {
    return this._archivedAt !== null;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ── mutators (in-place, return this) ────────────────────────────────────

  deactivate(now: Date): StaffMember {
    if (!this._isActive) return this;
    this._isActive = false;
    this._firedAt = now;
    this._updatedAt = now;
    return this;
  }

  activate(now: Date): StaffMember {
    if (this._isActive) return this;
    this._isActive = true;
    this._firedAt = null;
    this._updatedAt = now;
    return this;
  }

  archive(now: Date): StaffMember {
    if (this._archivedAt !== null) return this;
    this._archivedAt = now;
    this._isActive = false;
    this._updatedAt = now;
    return this;
  }

  restore(now: Date): StaffMember {
    if (this._archivedAt === null) return this;
    this._archivedAt = null;
    this._isActive = true;
    this._updatedAt = now;
    return this;
  }

  /**
   * Update role + specialist type atomically. Re-validates the matrix; if
   * the new role is not specialist, specialistType is forced to null.
   */
  updateRole(
    role: StaffRole,
    specialistType: SpecialistType | null,
    now: Date,
  ): StaffMember {
    StaffMember.validateRole(role);
    const nextSpecialist = role === 'specialist' ? specialistType : null;
    StaffMember.validateRoleMatrix(role, nextSpecialist);
    this._role = role;
    this._specialistType = nextSpecialist;
    this._updatedAt = now;
    return this;
  }

  rename(fullName: string, now: Date): StaffMember {
    this._fullName = fullName;
    this._updatedAt = now;
    return this;
  }

  toState(): StaffMemberState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      userId: this.userId,
      fullName: this._fullName,
      phone: this._phone,
      role: this._role,
      specialistType: this._specialistType,
      isActive: this._isActive,
      hiredAt: this._hiredAt,
      firedAt: this._firedAt,
      archivedAt: this._archivedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
