import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { KindergartenArchivedError } from '../errors/kindergarten-archived.error';

/**
 * Free-form JSONB bag. Concrete keys are documented in plans/schema.dbml
 * (timezone, currency, late_pickup_fee_amount, otp_expiry_seconds,
 * prepay_*_discount, payment_grace_days, fiscal_*).
 */
export type KindergartenSettings = Record<string, unknown>;

export interface KindergartenState {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  plan: string;
  settings: KindergartenSettings;
  isActive: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenant root entity. POJO domain — no TypeORM, no nestjs imports. Mappers
 * translate this to/from `KindergartenEntity` (TypeORM row).
 *
 * Two soft-delete signals coexist: `isActive=false` is the legacy boolean,
 * `archivedAt` is the new timestamp. Methods keep them in sync — `archive()`
 * sets both, `restore()` clears both.
 */
export class Kindergarten {
  private constructor(
    readonly id: string,
    private _name: string,
    readonly slug: string,
    private _address: string | null,
    private _phone: string | null,
    private _plan: string,
    private _settings: KindergartenSettings,
    private _isActive: boolean,
    private _archivedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: KindergartenState): Kindergarten {
    return new Kindergarten(
      state.id,
      state.name,
      state.slug,
      state.address,
      state.phone,
      state.plan,
      state.settings,
      state.isActive,
      state.archivedAt,
      state.createdAt,
      state.updatedAt,
    );
  }

  get name(): string {
    return this._name;
  }
  get address(): string | null {
    return this._address;
  }
  get phone(): string | null {
    return this._phone;
  }
  get plan(): string {
    return this._plan;
  }
  get settings(): KindergartenSettings {
    return this._settings;
  }
  get isActive(): boolean {
    return this._isActive;
  }
  get archivedAt(): Date | null {
    return this._archivedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get isArchived(): boolean {
    return this._archivedAt !== null;
  }

  /**
   * Sets archivedAt + isActive=false. Idempotent — re-archiving a row that's
   * already archived is a no-op (returns this without mutating).
   */
  archive(now: Date): Kindergarten {
    if (this._archivedAt !== null) return this;
    this._archivedAt = now;
    this._isActive = false;
    this._updatedAt = now;
    return this;
  }

  /**
   * Clears archivedAt + sets isActive=true. Idempotent.
   */
  restore(now: Date): Kindergarten {
    if (this._archivedAt === null && this._isActive) return this;
    this._archivedAt = null;
    this._isActive = true;
    this._updatedAt = now;
    return this;
  }

  /**
   * Replaces settings wholesale. Throws KindergartenArchivedError if the
   * caller tries to mutate a soft-deleted row.
   */
  updateSettings(next: KindergartenSettings, now: Date): Kindergarten {
    if (this._archivedAt !== null) {
      throw new KindergartenArchivedError(this.id);
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new InvariantViolationError('settings must be an object');
    }
    this._settings = { ...next };
    this._updatedAt = now;
    return this;
  }

  toState(): KindergartenState {
    return {
      id: this.id,
      name: this._name,
      slug: this.slug,
      address: this._address,
      phone: this._phone,
      plan: this._plan,
      settings: this._settings,
      isActive: this._isActive,
      archivedAt: this._archivedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
