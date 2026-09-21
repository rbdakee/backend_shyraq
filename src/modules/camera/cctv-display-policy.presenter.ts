import { KG_DEFAULT_TIMEZONE } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { CctvDisplayPolicy } from './domain/entities/cctv-display-policy.entity';
import { CctvDisplayPolicyDto } from './dto/cctv-display-policy-response.dto';

export class CctvDisplayPolicyPresenter {
  static policy(policy: CctvDisplayPolicy): CctvDisplayPolicyDto {
    const workHours = policy.workHours;
    const offHours = policy.offHours;
    return {
      work_days: policy.workDays,
      opens_at: policy.opensAt,
      closes_at: policy.closesAt,
      // Single-region MVP: the window is read in the app's fixed zone, the
      // same one every other date-only rule uses. Exposed so the UI can label
      // the times instead of implying the admin's own browser zone.
      timezone: KG_DEFAULT_TIMEZONE,
      work_hours: { mode: workHours.mode, camera_ids: workHours.cameraIds },
      off_hours: { mode: offHours.mode, camera_ids: offHours.cameraIds },
      updated_at: policy.updatedAt.toISOString(),
    };
  }
}
