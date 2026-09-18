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
 * The chain is deliberately "where the child is *now*", not "where the child
 * belongs": child → current group → where that group is at this instant →
 * cameras anchored to that location.
 *
 * "At this instant" is read from the schedule, not stored: the activity event
 * covering now carries the room, so the list follows the day on its own — the
 * group eats in the canteen at noon and the canteen cameras appear, with no
 * cron writing a field and no staff action required. `current_location_id` is
 * the fallback for groups that have no schedule (or none right now).
 *
 * Nothing pushes this to clients, so the app must re-request rather than cache
 * — which it has to do anyway, since go2rtc HLS sessions expire in seconds.
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

    const locationId = await this.resolveLocationId(kindergartenId, groupId);
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
        streams: buildStreamVariants(camera, minted.token, this.publicBase()),
      };
    });

    return { cameras: views, expiresAt };
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
  ): Promise<string | null> {
    const current = await this.events.findCurrentForGroup(
      kindergartenId,
      groupId,
      this.clock.now(),
    );
    if (current?.locationId) return current.locationId;

    const group = await this.groups.findById(kindergartenId, groupId);
    return group?.currentLocationId ?? null;
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
