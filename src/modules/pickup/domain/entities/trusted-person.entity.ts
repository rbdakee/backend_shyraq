/**
 * Plain TS view of a `trusted_people` row. Lives in domain because it's the
 * contract the application/infrastructure layers use to rehydrate a
 * `TrustedPerson` without leaking TypeORM types upward.
 */
export interface TrustedPersonState {
  id: string;
  kindergartenId: string;
  childId: string;
  addedByUserId: string;
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isActive: boolean;
  isOneTime: boolean;
  usedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CreateTrustedPersonInput {
  id: string;
  kindergartenId: string;
  childId: string;
  addedByUserId: string;
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isOneTime: boolean;
  createdAt: Date;
}

/**
 * TrustedPerson aggregate (B11). POJO — no TypeORM/Nest imports. Immutable:
 * lifecycle transitions (`revoke`, `markUsed`) return new instances rather
 * than mutating in place. This matches the QrToken pattern.
 *
 * Lifecycle:
 *   active (isActive=true, revokedAt=null)
 *     → revoked   (terminal, via revoke()) — explicit deletion by parent or admin
 *     → markUsed when isOneTime=true → auto-deactivates (isActive=false) but
 *       does NOT set revokedAt — it's a "used up" state, not a revocation.
 *
 * `isAvailableForPickup()` is the canonical guard the service consults when
 * deciding whether a TrustedPerson row is eligible to back a pickup_request.
 */
export class TrustedPerson {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly childId: string,
    readonly addedByUserId: string,
    readonly fullName: string,
    readonly phone: string,
    readonly iin: string | null,
    readonly relation: string,
    readonly photoUrl: string | null,
    readonly isActive: boolean,
    readonly isOneTime: boolean,
    readonly usedAt: Date | null,
    readonly createdAt: Date,
    readonly revokedAt: Date | null,
  ) {}

  static create(input: CreateTrustedPersonInput): TrustedPerson {
    return new TrustedPerson(
      input.id,
      input.kindergartenId,
      input.childId,
      input.addedByUserId,
      input.fullName,
      input.phone,
      input.iin,
      input.relation,
      input.photoUrl,
      true,
      input.isOneTime,
      null,
      input.createdAt,
      null,
    );
  }

  static fromState(state: TrustedPersonState): TrustedPerson {
    return new TrustedPerson(
      state.id,
      state.kindergartenId,
      state.childId,
      state.addedByUserId,
      state.fullName,
      state.phone,
      state.iin,
      state.relation,
      state.photoUrl,
      state.isActive,
      state.isOneTime,
      state.usedAt,
      state.createdAt,
      state.revokedAt,
    );
  }

  isRevoked(): boolean {
    return this.revokedAt !== null;
  }

  /**
   * Eligibility guard used by `PickupRequestService` before creating a
   * pickup_request bound to this trusted_person. Encodes:
   *   - row must currently be active,
   *   - must not have been revoked,
   *   - if it's a one-time row, must not have been used yet.
   *
   * `usedAt` is informational for non-one-time rows (audit-style "last
   * pickup at"), so the one-time gate only applies when `isOneTime=true`.
   */
  isAvailableForPickup(): boolean {
    if (!this.isActive) return false;
    if (this.revokedAt !== null) return false;
    if (this.isOneTime && this.usedAt !== null) return false;
    return true;
  }

  /**
   * Returns a new TrustedPerson stamped as revoked. Throws when already
   * revoked or already deactivated — terminal-state guard, matches
   * QrToken.revoke. Calling code that needs idempotency should check
   * `isRevoked()` / `isActive` first.
   */
  revoke(now: Date): TrustedPerson {
    if (this.isRevoked()) {
      throw new Error('TrustedPerson.revoke: already revoked');
    }
    if (!this.isActive) {
      throw new Error(
        'TrustedPerson.revoke: cannot revoke a non-active trusted person',
      );
    }
    return new TrustedPerson(
      this.id,
      this.kindergartenId,
      this.childId,
      this.addedByUserId,
      this.fullName,
      this.phone,
      this.iin,
      this.relation,
      this.photoUrl,
      false,
      this.isOneTime,
      this.usedAt,
      this.createdAt,
      now,
    );
  }

  /**
   * Returns a new TrustedPerson with `usedAt = now`. When `isOneTime` is
   * true, the row is also auto-deactivated (sets `isActive = false`) so it
   * cannot back a second pickup_request. Non-one-time rows stay active —
   * `usedAt` becomes a "last used" audit field there.
   *
   * Permissive about lifecycle state: if the row is already used as a
   * one-time and re-used erroneously, `isAvailableForPickup()` is the
   * service-layer guard that should have prevented the call. The entity
   * does not second-guess.
   */
  markUsed(now: Date): TrustedPerson {
    const newIsActive = this.isOneTime ? false : this.isActive;
    return new TrustedPerson(
      this.id,
      this.kindergartenId,
      this.childId,
      this.addedByUserId,
      this.fullName,
      this.phone,
      this.iin,
      this.relation,
      this.photoUrl,
      newIsActive,
      this.isOneTime,
      now,
      this.createdAt,
      this.revokedAt,
    );
  }

  toState(): TrustedPersonState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      addedByUserId: this.addedByUserId,
      fullName: this.fullName,
      phone: this.phone,
      iin: this.iin,
      relation: this.relation,
      photoUrl: this.photoUrl,
      isActive: this.isActive,
      isOneTime: this.isOneTime,
      usedAt: this.usedAt,
      createdAt: this.createdAt,
      revokedAt: this.revokedAt,
    };
  }
}
