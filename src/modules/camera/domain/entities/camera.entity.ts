import {
  StreamTransport,
  transportsForCodec,
  VideoCodec,
} from '../value-objects/video-codec.vo';

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
  streamKey: string | null;
  streamKeyHd: string | null;
  videoCodec: VideoCodec | null;
  codecCheckedAt: Date | null;
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
    private _streamKey: string | null,
    private _streamKeyHd: string | null,
    private _videoCodec: VideoCodec | null,
    private _codecCheckedAt: Date | null,
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
      state.streamKey,
      state.streamKeyHd,
      state.videoCodec,
      state.codecCheckedAt,
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
  get streamKey(): string | null {
    return this._streamKey;
  }
  get streamKeyHd(): string | null {
    return this._streamKeyHd;
  }
  /** Last probed codec, or null when this camera has never been probed. */
  get videoCodec(): VideoCodec | null {
    return this._videoCodec;
  }
  /** Timestamp of the last *successful* probe. Null = never answered. */
  get codecCheckedAt(): Date | null {
    return this._codecCheckedAt;
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

  /**
   * A camera is streamable only once someone has pointed it at a media-gateway
   * stream key. Rows created before the key is filled in are legitimate config
   * (the admin registers the camera, the key lands during gateway setup) —
   * they simply produce no playable URLs.
   */
  get isStreamable(): boolean {
    return this._streamKey !== null && this._isActive && !this.isArchived;
  }

  /** Codec with the never-probed case folded into `unknown`. */
  get effectiveCodec(): VideoCodec {
    return this._videoCodec ?? 'unknown';
  }

  /**
   * Transports this camera can be watched over, most-preferred first. Empty
   * while the camera is not streamable. The codec→transport rule itself lives
   * in the value object, so flipping a camera to H.264 widens this list with
   * no code change anywhere.
   */
  get availableTransports(): StreamTransport[] {
    if (!this.isStreamable) return [];
    return transportsForCodec(this.effectiveCodec);
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

  /**
   * Point the camera at media-gateway streams: `streamKey` is the low-res
   * sub-stream everyone watches, `streamKeyHd` the optional full-res one.
   * Changing the key invalidates what we know about the codec — the new key
   * may well be a different camera — so the probe state is reset and the next
   * probe re-establishes it.
   */
  setStreamKeys(
    keys: { streamKey?: string | null; streamKeyHd?: string | null },
    now: Date,
  ): Camera {
    let changed = false;
    if (keys.streamKey !== undefined && keys.streamKey !== this._streamKey) {
      this._streamKey = keys.streamKey;
      changed = true;
    }
    if (
      keys.streamKeyHd !== undefined &&
      keys.streamKeyHd !== this._streamKeyHd
    ) {
      this._streamKeyHd = keys.streamKeyHd;
      changed = true;
    }
    if (changed) {
      this._videoCodec = null;
      this._codecCheckedAt = null;
      this._updatedAt = now;
    }
    return this;
  }

  /**
   * Record a successful probe. This is the hinge of the whole codec-agnostic
   * design: nobody edits `video_codec` by hand, the probe job writes what the
   * camera actually emits and the transport list follows.
   */
  recordCodecProbe(codec: VideoCodec, now: Date): Camera {
    this._videoCodec = codec;
    this._codecCheckedAt = now;
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
      streamKey: this._streamKey,
      streamKeyHd: this._streamKeyHd,
      videoCodec: this._videoCodec,
      codecCheckedAt: this._codecCheckedAt,
      isActive: this._isActive,
      archivedAt: this._archivedAt,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
