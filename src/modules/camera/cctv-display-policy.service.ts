import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CctvDisplayPolicy } from './domain/entities/cctv-display-policy.entity';
import { CameraArchivedError } from './domain/errors/camera-archived.error';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { CameraRepository } from './infrastructure/persistence/camera.repository';
import {
  CctvDisplayPolicyRepository,
  SaveCctvDisplayPolicyInput,
} from './infrastructure/persistence/cctv-display-policy.repository';

/**
 * CctvDisplayPolicyService — reads and writes the one row that decides what
 * parents are shown, and when.
 *
 * Read side is deliberately total: a kindergarten that has never saved a
 * policy gets `CctvDisplayPolicy.default()` rather than null, so neither the
 * admin screen nor the parent hot path has to special-case "not configured".
 */
@Injectable()
export class CctvDisplayPolicyService {
  constructor(
    private readonly policies: CctvDisplayPolicyRepository,
    private readonly cameras: CameraRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  /** The kindergarten's policy, or the defaults when it has never saved one. */
  async get(kindergartenId: string): Promise<CctvDisplayPolicy> {
    const stored = await this.policies.findByKindergarten(kindergartenId);
    return (
      stored ?? CctvDisplayPolicy.default(kindergartenId, this.clock.now())
    );
  }

  /**
   * Replaces the whole policy. The admin screen always posts every field, so
   * there is no patch semantics to get wrong — and validating the assembled
   * entity means an inverted window or a bad weekday is refused by the domain
   * before it reaches the CHECK constraints.
   */
  async save(
    kindergartenId: string,
    input: SaveCctvDisplayPolicyInput,
  ): Promise<CctvDisplayPolicy> {
    const now = this.clock.now();
    const candidate = CctvDisplayPolicy.hydrate({
      kindergartenId,
      workDays: input.workDays,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      workHours: input.workHours,
      offHours: input.offHours,
      createdAt: now,
      updatedAt: now,
    });

    await this.assertCamerasUsable(
      kindergartenId,
      candidate.referencedCameraIds,
    );

    return this.policies.upsert(kindergartenId, {
      workDays: candidate.workDays,
      opensAt: candidate.opensAt,
      closesAt: candidate.closesAt,
      workHours: candidate.workHours,
      offHours: candidate.offHours,
    });
  }

  /**
   * Every camera the policy names must exist in THIS kindergarten and be live.
   *
   * There is no foreign key behind these ids (see the migration), so this is
   * the only thing standing between a typo — or another tenant's uuid — and a
   * policy that silently shows nothing. Archived cameras are refused here
   * rather than at read time: pointing parents at a camera that is switched
   * off is a mistake worth surfacing while the admin is still on the screen.
   */
  private async assertCamerasUsable(
    kindergartenId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.cameras.listByIds(kindergartenId, ids);
    const byId = new Map(found.map((camera) => [camera.id, camera]));
    for (const id of ids) {
      const camera = byId.get(id);
      if (!camera) throw new CameraNotFoundError(id);
      if (camera.isArchived) throw new CameraArchivedError(id);
    }
  }
}
