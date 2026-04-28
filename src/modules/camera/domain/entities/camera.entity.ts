/**
 * Camera domain entity. Tenant-scoped — every camera belongs to exactly one
 * kindergarten and is anchored to a single location. Mutators return `this`
 * after applying the change so the service layer can chain them before
 * persisting via `toState()`.
 */
export interface CameraState {
  id: string;
  kindergartenId: string;
  locationId: string;
  name: string;
  rtspUrl: string;
  hlsUrl: string | null;
  isActive: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Camera {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    private _locationId: string,
    private _name: string,
    private _rtspUrl: string,
    private _hlsUrl: string | null,
    private _isActive: boolean,
    private _archivedAt: Date | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: CameraState): Camera {
    return new Camera(
      state.id,
      state.kindergartenId,
      state.locationId,
      state.name,
      state.rtspUrl,
      state.hlsUrl,
      state.isActive,
      state.archivedAt,
      state.createdAt,
      state.updatedAt,
    );
  }

  get locationId(): string {
    return this._locationId;
  }
  get name(): string {
    return this._name;
  }
  get rtspUrl(): string {
    return this._rtspUrl;
  }
  get hlsUrl(): string | null {
    return this._hlsUrl;
  }
  get isActive(): boolean {
    return this._isActive;
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

  rename(name: string, now: Date): Camera {
    this._name = name;
    this._updatedAt = now;
    return this;
  }

  setRtspUrl(url: string, now: Date): Camera {
    this._rtspUrl = url;
    this._updatedAt = now;
    return this;
  }

  setHlsUrl(url: string | null, now: Date): Camera {
    this._hlsUrl = url;
    this._updatedAt = now;
    return this;
  }

  /**
   * Move the camera to a different location within the same tenant. The
   * service layer must verify the new location belongs to the same kg.
   */
  linkToLocation(locationId: string, now: Date): Camera {
    this._locationId = locationId;
    this._updatedAt = now;
    return this;
  }

  archive(now: Date): Camera {
    if (this._archivedAt !== null) return this;
    this._archivedAt = now;
    this._isActive = false;
    this._updatedAt = now;
    return this;
  }

  restore(now: Date): Camera {
    if (this._archivedAt === null) return this;
    this._archivedAt = null;
    this._isActive = true;
    this._updatedAt = now;
    return this;
  }

  toState(): CameraState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      locationId: this._locationId,
      name: this._name,
      rtspUrl: this._rtspUrl,
      hlsUrl: this._hlsUrl,
      isActive: this._isActive,
      archivedAt: this._archivedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
