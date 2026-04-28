import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * Group rich aggregate. The `Group` instance carries the immutable identity
 * fields plus the mutable name/capacity/age-range/location/archive flags;
 * mentor assignment lives in a sibling `GroupMentor` aggregate (one row per
 * historical assignment) so the partial-unique DB index can enforce the
 * "one active mentor per group" invariant directly.
 */
export interface GroupState {
  id: string;
  kindergartenId: string;
  name: string;
  capacity: number;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  currentLocationId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Group {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    private _name: string,
    private _capacity: number,
    private _ageRangeMin: number | null,
    private _ageRangeMax: number | null,
    private _currentLocationId: string | null,
    private _archivedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: GroupState): Group {
    Group.validateCapacity(state.capacity);
    Group.validateAgeRange(state.ageRangeMin, state.ageRangeMax);
    return new Group(
      state.id,
      state.kindergartenId,
      state.name,
      state.capacity,
      state.ageRangeMin,
      state.ageRangeMax,
      state.currentLocationId,
      state.archivedAt,
      state.createdAt,
      state.updatedAt,
    );
  }

  static validateCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new InvariantViolationError(
        `group capacity must be a positive integer, got ${capacity}`,
      );
    }
  }

  static validateAgeRange(min: number | null, max: number | null): void {
    if (min !== null && max !== null && min >= max) {
      throw new InvariantViolationError(
        `invalid age range: min=${min} max=${max} — require min < max`,
      );
    }
  }

  // ── getters ─────────────────────────────────────────────────────────────

  get name(): string {
    return this._name;
  }
  get capacity(): number {
    return this._capacity;
  }
  get ageRangeMin(): number | null {
    return this._ageRangeMin;
  }
  get ageRangeMax(): number | null {
    return this._ageRangeMax;
  }
  get currentLocationId(): string | null {
    return this._currentLocationId;
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

  // ── mutators ────────────────────────────────────────────────────────────

  rename(name: string, now: Date): Group {
    this._name = name;
    this._updatedAt = now;
    return this;
  }

  updateCapacity(capacity: number, now: Date): Group {
    Group.validateCapacity(capacity);
    this._capacity = capacity;
    this._updatedAt = now;
    return this;
  }

  updateAgeRange(min: number | null, max: number | null, now: Date): Group {
    Group.validateAgeRange(min, max);
    this._ageRangeMin = min;
    this._ageRangeMax = max;
    this._updatedAt = now;
    return this;
  }

  setLocation(locationId: string | null, now: Date): Group {
    this._currentLocationId = locationId;
    this._updatedAt = now;
    return this;
  }

  archive(now: Date): Group {
    if (this._archivedAt !== null) return this;
    this._archivedAt = now;
    this._updatedAt = now;
    return this;
  }

  restore(now: Date): Group {
    if (this._archivedAt === null) return this;
    this._archivedAt = null;
    this._updatedAt = now;
    return this;
  }

  toState(): GroupState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      name: this._name,
      capacity: this._capacity,
      ageRangeMin: this._ageRangeMin,
      ageRangeMax: this._ageRangeMax,
      currentLocationId: this._currentLocationId,
      archivedAt: this._archivedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
