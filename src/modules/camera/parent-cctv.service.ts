import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { ActivityEventRepository } from '@/modules/schedule/infrastructure/persistence/activity-event.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { CctvDisplayPolicyService } from './cctv-display-policy.service';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera } from './domain/entities/camera.entity';
import { CctvAccessDeniedError } from './domain/errors/cctv-access-denied.error';
import { CctvDisplayMode } from './domain/value-objects/cctv-display-mode.vo';
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
  /** Which rule produced this list — see `CctvDisplayMode`. */
  displayMode: CctvDisplayMode;
}

/**
 * ParentCctvService — resolves which cameras a parent may watch right now.
 *
 * The kindergarten's display policy answers first (`CctvDisplayPolicyService`):
 * it splits the day into working hours and everything else, and each half is
 * either schedule-driven, a fixed list of cameras, or nothing at all. A
 * kindergarten that never touched the setting runs on schedule-driven around
 * the clock, which is what this service did before the policy existed.
 *
 * Schedule-driven means "where the child is *now*", not "where the child
 * belongs": child → current group → where that group is at this instant →
 * cameras anchored to that location. "At this instant" is read from the
 * schedule, not stored: the activity event covering now carries the room, so
 * the list follows the day on its own — the group eats in the canteen at noon
 * and the canteen cameras appear, with no cron writing a field and no staff
 * action required. `current_location_id` is the fallback for groups that have
 * no schedule (or none right now), and the policy's own camera list is the
 * last resort when even that leads nowhere.
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
    private readonly events: ActivityEventRepository,
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
    const decision = policy.decideAt(now);
    if (decision.mode === 'off') return this.empty(decision.mode);

    const cameras =
      decision.mode === 'cameras'
        ? await this.pinnedCameras(kindergartenId, decision.cameraIds)
        : await this.camerasWhereTheGroupIs(
            kindergartenId,
            child.currentGroupId ?? null,
            decision.cameraIds,
            now,
          );
    if (cameras.length === 0) return this.empty(decision.mode);

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

    return { cameras: views, expiresAt, displayMode: decision.mode };
  }

  /**
   * The schedule-driven list: cameras covering the room the child's group is
   * in at this instant, and — only when that yields nothing — the policy's
   * fallback cameras.
   *
   * No group, or a group that is not anchored anywhere, is not an error: it
   * simply means there is nothing of the child's own to point a camera at, and
   * the fallback (typically the entrance) is what the kindergarten wants shown
   * instead.
   */
  private async camerasWhereTheGroupIs(
    kindergartenId: string,
    groupId: string | null,
    fallbackCameraIds: string[],
    now: Date,
  ): Promise<Camera[]> {
    const locationId = groupId
      ? await this.resolveLocationId(kindergartenId, groupId, now)
      : null;

    if (locationId) {
      const atLocation = (
        await this.cameras.list(kindergartenId, {
          locationId,
          archived: false,
        })
      ).filter((camera) => camera.isStreamable);
      if (atLocation.length > 0) return atLocation;
    }

    return this.pinnedCameras(kindergartenId, fallbackCameraIds);
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
   * Where the group is right now. The schedule answers first — its event
   * carries the room and expires on its own — and the hand-set
   * `current_location_id` answers when no event covers this instant.
   *
   * An event whose own `location_id` is empty says nothing about place, so it
   * falls through to the group as well; it must not blank out the list.
   */
  private async resolveLocationId(
    kindergartenId: string,
    groupId: string,
    now: Date,
  ): Promise<string | null> {
    const current = await this.events.findCurrentForGroup(
      kindergartenId,
      groupId,
      now,
    );
    if (current?.locationId) return current.locationId;

    const group = await this.groups.findById(kindergartenId, groupId);
    return group?.currentLocationId ?? null;
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

  private empty(displayMode: CctvDisplayMode): CctvAccessView {
    return { cameras: [], expiresAt: null, displayMode };
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
