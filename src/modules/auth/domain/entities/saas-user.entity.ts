export type SaasUserRole = 'super_admin' | 'support';

export interface SaasUserState {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  passwordHash: string;
  role: SaasUserRole;
  isActive: boolean;
  lastLoginAt: Date | null;
}

/**
 * SaaS-operator identity (super_admin / support staff). Pure POJO — never
 * tenant-scoped, never bound to a kindergarten. Stored in `saas_users`.
 */
export class SaasUser {
  private constructor(
    readonly id: string,
    readonly email: string,
    readonly phone: string | null,
    private _fullName: string,
    readonly passwordHash: string,
    readonly role: SaasUserRole,
    readonly isActive: boolean,
    private _lastLoginAt: Date | null,
  ) {}

  static hydrate(state: SaasUserState): SaasUser {
    return new SaasUser(
      state.id,
      state.email,
      state.phone,
      state.fullName,
      state.passwordHash,
      state.role,
      state.isActive,
      state.lastLoginAt,
    );
  }

  get fullName(): string {
    return this._fullName;
  }

  get lastLoginAt(): Date | null {
    return this._lastLoginAt;
  }

  toState(): SaasUserState {
    return {
      id: this.id,
      email: this.email,
      phone: this.phone,
      fullName: this._fullName,
      passwordHash: this.passwordHash,
      role: this.role,
      isActive: this.isActive,
      lastLoginAt: this._lastLoginAt,
    };
  }
}
