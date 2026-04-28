import { InvariantViolationError } from '@/shared-kernel/domain/errors';

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
  role: StaffRole;
  specialistType: string | null;
  isActive: boolean;
  hiredAt: Date | null;
  firedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal P3 StaffMember domain — only what's needed for the admin-staff seed
 * row produced by createKindergarten + the AuthService P4 lookup. Full role
 * matrix invariants (specialist_type whitelist, group_mentors, etc.) land in
 * P4 alongside the rest of the staff endpoints.
 */
export class StaffMember {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly userId: string,
    private _role: StaffRole,
    private _specialistType: string | null,
    private _isActive: boolean,
    private _hiredAt: Date | null,
    private _firedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: StaffMemberState): StaffMember {
    StaffMember.validateRole(state.role);
    return new StaffMember(
      state.id,
      state.kindergartenId,
      state.userId,
      state.role,
      state.specialistType,
      state.isActive,
      state.hiredAt,
      state.firedAt,
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

  get role(): StaffRole {
    return this._role;
  }
  get specialistType(): string | null {
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
  get updatedAt(): Date {
    return this._updatedAt;
  }

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

  toState(): StaffMemberState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      userId: this.userId,
      role: this._role,
      specialistType: this._specialistType,
      isActive: this._isActive,
      hiredAt: this._hiredAt,
      firedAt: this._firedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
