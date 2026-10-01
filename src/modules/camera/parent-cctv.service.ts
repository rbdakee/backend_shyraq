import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { CctvDisplayPolicyService } from './cctv-display-policy.service';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera } from './domain/entities/camera.entity';
import { CctvAccessDeniedError } from './domain/errors/cctv-access-denied.error';
import { buildStreamVariants, CctvStreamVariant } from './cctv-stream-urls';
import { CameraRepository } from './infrastructure/persistence/camera.repository';

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
 * Two parts, in this order:
 *  1. The child's group camera — every camera in the location the group is
 *     assigned to (`groups.current_location_id`). Always shown; the display
 *     policy cannot hide it. Group schedules are not consulted: kindergartens
 *     do not run them, and a scheduled room would move the camera away from
 *     the group's own.
 *  2. The kindergarten's common cameras (canteen, clubs) from the display
 *     policy, minus those its time rules hide at this instant.
 *
 * Nothing pushes this to clients, so the app must re-request rather than cache
 * — which it has to do anyway, since go2rtc HLS sessions expire in seconds.
 * That is also what makes a policy change take effect: the next request reads
 * the new row.
 */
@Injectable()
export class ParentCctvService {
  constructor(
    private readonly children: ChildRepository,
    private readonly groups: GroupRepository,
    private readonly cameras: CameraRepository,
    private readonly locations: LocationRepository,
    private readonly clock: ClockPort,
    private readonly tokens: CctvStreamTokenService,
    private readonly policies: CctvDisplayPolicyService,
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

    const now = this.clock.now();
    const policy = await this.policies.get(kindergartenId);
    const groupCameras = await this.groupCameras(
      kindergartenId,
      child.currentGroupId ?? null,
    );
    const shown = new Set(groupCameras.map((camera) => camera.id));
    const commonCameras = (
      await this.pinnedCameras(
        kindergartenId,
        policy.visibleCommonCameraIds(now),
      )
    ).filter((camera) => !shown.has(camera.id));
    const cameras = [...groupCameras, ...commonCameras];
    if (cameras.length === 0) return this.empty();

    const locationNames = await this.locationNames(kindergartenId);

    let expiresAt: Date | null = null;
    const views: CctvCameraView[] = cameras.map((camera) => {
      const minted = this.tokens.mint(camera.id, userId);
      // Every camera gets its own token (scoped to that camera id), but they
      // are minted in the same tick, so one expiry covers the batch.
      expiresAt = minted.expiresAt;
      return {
        camera,
        locationName: locationNames.get(camera.locationId) ?? null,
        streams: buildStreamVariants(camera, minted.token, this.publicBase()),
      };
    });

    return { cameras: views, expiresAt };
  }

  /**
   * Cameras in the room the child's group is assigned to. No group, or a
   * group not anchored anywhere, is not an error — the parent then sees only
   * the common cameras.
   */
  private async groupCameras(
    kindergartenId: string,
    groupId: string | null,
  ): Promise<Camera[]> {
    if (!groupId) return [];
    const group = await this.groups.findById(kindergartenId, groupId);
    if (!group?.currentLocationId) return [];
    const atLocation = await this.cameras.list(kindergartenId, {
      locationId: group.currentLocationId,
      archived: false,
    });
    return atLocation.filter((camera) => camera.isStreamable);
  }

  /**
   * Cameras the policy names, in the admin's order, minus anything that is no
   * longer playable. An id that does not resolve is dropped rather than
   * raised: the policy holds ids without a foreign key, and an archived or
   * unkeyed camera must not blank out the rest of the list.
   */
  private async pinnedCameras(
    kindergartenId: string,
    cameraIds: string[],
  ): Promise<Camera[]> {
    if (cameraIds.length === 0) return [];
    const rows = await this.cameras.listByIds(kindergartenId, cameraIds);
    return rows.filter((camera) => camera.isStreamable);
  }

  /**
   * Location id → name for the whole tenant, in one read. A fixed camera list
   * can span rooms, so per-camera `findById` would be a query per camera;
   * archived locations are included on purpose, since a camera may still hang
   * in one and the parent should see its name rather than a blank.
   */
  private async locationNames(
    kindergartenId: string,
  ): Promise<Map<string, string>> {
    const rows = await this.locations.list(kindergartenId);
    return new Map(rows.map((location) => [location.id, location.name]));
  }

  private empty(): CctvAccessView {
    return { cameras: [], expiresAt: null };
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
