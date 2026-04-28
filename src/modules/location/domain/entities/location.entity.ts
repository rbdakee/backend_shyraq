/**
 * Location domain entity. Tenant-scoped — every Location belongs to exactly
 * one kindergarten. Mutations return `this` after updating internal state;
 * the repository persists via `toState()`.
 */
export interface LocationState {
  id: string;
  kindergartenId: string;
  name: string;
  description: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Location {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    private _name: string,
    private _description: string | null,
    private _archivedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: LocationState): Location {
    return new Location(
      state.id,
      state.kindergartenId,
      state.name,
      state.description,
      state.archivedAt,
      state.createdAt,
      state.updatedAt,
    );
  }

  get name(): string {
    return this._name;
  }
  get description(): string | null {
    return this._description;
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

  rename(name: string, now: Date): Location {
    this._name = name;
    this._updatedAt = now;
    return this;
  }

  setDescription(description: string | null, now: Date): Location {
    this._description = description;
    this._updatedAt = now;
    return this;
  }

  archive(now: Date): Location {
    if (this._archivedAt !== null) return this;
    this._archivedAt = now;
    this._updatedAt = now;
    return this;
  }

  restore(now: Date): Location {
    if (this._archivedAt === null) return this;
    this._archivedAt = null;
    this._updatedAt = now;
    return this;
  }

  toState(): LocationState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      name: this._name,
      description: this._description,
      archivedAt: this._archivedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
