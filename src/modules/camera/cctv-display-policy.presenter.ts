import { KG_DEFAULT_TIMEZONE } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { CctvDisplayPolicy } from './domain/entities/cctv-display-policy.entity';
import { CctvDisplayPolicyDto } from './dto/cctv-display-policy-response.dto';

export class CctvDisplayPolicyPresenter {
  static policy(policy: CctvDisplayPolicy): CctvDisplayPolicyDto {
    return {
      common_camera_ids: policy.commonCameraIds,
      hide_rules: policy.hideRules.map((rule) => ({
        name: rule.name,
        enabled: rule.enabled,
        days: rule.days,
        from: rule.from,
        to: rule.to,
        all_cameras: rule.allCameras,
        camera_ids: rule.cameraIds,
      })),
      // Single-region MVP: rule windows are read in the app's fixed zone, the
      // same one every other date-only rule uses. Exposed so the UI can label
      // the times instead of implying the admin's own browser zone.
      timezone: KG_DEFAULT_TIMEZONE,
      updated_at: policy.updatedAt.toISOString(),
    };
  }
}
