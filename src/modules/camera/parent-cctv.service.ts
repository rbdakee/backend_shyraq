import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera } from './domain/entities/camera.entity';
import { CctvAccessDeniedError } from './domain/errors/cctv-access-denied.error';
import { StreamTransport } from './domain/value-objects/video-codec.vo';
import { CameraRepository } from './infrastructure/persistence/camera.repository';

/**
 * Transports the backend can actually serve today.
 *
 * A camera may *support* WebRTC (that is what `Camera.availableTransports`
 * reports once it emits H.264), but advertising a URL we cannot serve would
 * hand the app a dead link. So the served list is the intersection of what the
 * camera supports and what is wired up here. When the WebRTC path is built,
 * add `'webrtc'` to this set and every H.264 camera starts offering it — no
 * other change.
 */
const SERVABLE_TRANSPORTS: ReadonlySet<StreamTransport> = new Set(['hls']);

export interface CctvStreamVariant {
  transport: StreamTransport;
  url: string;
}

export interface CctvCameraView {
  camera: Camera;
  locationName: string | null;
  streams: CctvStreamVariant[];
}

export interface CctvAccessView {
  cameras: CctvCameraView[];
  expiresAt: Date | null;
}

/**
 * ParentCctvService — resolves which cameras a parent may watch right now.
 *
 * The chain is deliberately "where the child is *now*", not "where the child
 * belongs": child → current group → the group's current location → cameras
 * anchored to that location. A mentor moving the group to the gym changes the
 * answer, which is why the app is told to re-fetch on the group's
 * location-changed event rather than caching the list.
 */
@Injectable()
export class ParentCctvService {
  constructor(
    private readonly children: ChildRepository,
    private readonly groups: GroupRepository,
    private readonly cameras: CameraRepository,
    private readonly locations: LocationRepository,
    private readonly tokens: CctvStreamTokenService,
    private readonly config: ConfigService<AllConfigType>,
  ) {}

  /** False when the streaming host or the signing key is not configured. */
  get isConfigured(): boolean {
    return this.publicBase() !== null && this.tokens.isConfigured;
  }

  async listForChild(
    kindergartenId: string,
    childId: string,
    userId: string,
    guardian: ChildGuardian | undefined,
  ): Promise<CctvAccessView> {
    this.assertGuardianMayView(guardian);

    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);

    // No group, or a group that is not anchored anywhere, means there is
    // nothing to point a camera at — an empty list, not an error.
    const groupId = child.currentGroupId;
    if (!groupId) return { cameras: [], expiresAt: null };

    const group = await this.groups.findById(kindergartenId, groupId);
    const locationId = group?.currentLocationId ?? null;
    if (!locationId) return { cameras: [], expiresAt: null };

    const cameras = (
      await this.cameras.list(kindergartenId, {
        locationId,
        archived: false,
      })
    ).filter((camera) => camera.isStreamable);
    if (cameras.length === 0) return { cameras: [], expiresAt: null };

    const location = await this.locations.findById(kindergartenId, locationId);
    const locationName = location?.name ?? null;

    let expiresAt: Date | null = null;
    const views: CctvCameraView[] = cameras.map((camera) => {
      const minted = this.tokens.mint(camera.id, userId);
      // Every camera gets its own token (scoped to that camera id), but they
      // are minted in the same tick, so one expiry covers the batch.
      expiresAt = minted.expiresAt;
      return {
        camera,
        locationName,
        streams: this.streamsFor(camera, minted.token),
      };
    });

    return { cameras: views, expiresAt };
  }

  private streamsFor(camera: Camera, token: string): CctvStreamVariant[] {
    const base = this.publicBase();
    if (!base) return [];
    return camera.availableTransports
      .filter((transport) => SERVABLE_TRANSPORTS.has(transport))
      .map((transport) => ({
        transport,
        url: `${base}/hls/${camera.id}/index.m3u8?t=${encodeURIComponent(token)}`,
      }));
  }

  private assertGuardianMayView(guardian: ChildGuardian | undefined): void {
    // Admin/staff tokens reach parent routes without a guardian record (the
    // access guard lets them through); they are already tenant-scoped by the
    // guard chain, so there is nothing further to check here.
    if (!guardian) return;
    const effective = guardian.permissions.effective(guardian.role);
    if (!effective.view_cctv) throw new CctvAccessDeniedError();
  }

  private publicBase(): string | null {
    return this.config.get('cctv.streamPublicBase', { infer: true }) ?? null;
  }
}
