/**
 * Tenant-user identity record. Pure POJO — domain layer must not depend on
 * TypeORM or any persistence concern. Mappers translate this to/from
 * `UserEntity` (TypeORM row).
 *
 * Phone is the natural key (E.164). Roles are stored elsewhere (UserRole
 * table) and joined by the auth/users service layer when assembling
 * UserProfileView. Kept deliberately minimal — only fields that are part of
 * the user's own identity, never tenant-scoped state.
 */
export interface UserState {
  id: string;
  phone: string;
  fullName: string;
  avatarUrl: string | null;
  iin: string | null;
  dateOfBirth: Date | null;
  locale: string;
}

export class User {
  private constructor(
    readonly id: string,
    readonly phone: string,
    private _fullName: string,
    private _avatarUrl: string | null,
    private _iin: string | null,
    private _dateOfBirth: Date | null,
    private _locale: string,
  ) {}

  static hydrate(state: UserState): User {
    return new User(
      state.id,
      state.phone,
      state.fullName,
      state.avatarUrl,
      state.iin,
      state.dateOfBirth,
      state.locale,
    );
  }

  get fullName(): string {
    return this._fullName;
  }

  get avatarUrl(): string | null {
    return this._avatarUrl;
  }

  get iin(): string | null {
    return this._iin;
  }

  get dateOfBirth(): Date | null {
    return this._dateOfBirth;
  }

  get locale(): string {
    return this._locale;
  }

  toState(): UserState {
    return {
      id: this.id,
      phone: this.phone,
      fullName: this._fullName,
      avatarUrl: this._avatarUrl,
      iin: this._iin,
      dateOfBirth: this._dateOfBirth,
      locale: this._locale,
    };
  }
}
