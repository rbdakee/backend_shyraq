import {
  CctvDisplayPolicy,
  CctvHideRule,
} from '../../../../domain/entities/cctv-display-policy.entity';
import {
  CctvDisplayPolicyEntity,
  CctvHideRuleRow,
} from '../entities/cctv-display-policy.entity';

export class CctvDisplayPolicyMapper {
  static toDomain(entity: CctvDisplayPolicyEntity): CctvDisplayPolicy {
    return CctvDisplayPolicy.hydrate({
      kindergartenId: entity.kindergarten_id,
      commonCameraIds: entity.common_camera_ids ?? [],
      hideRules: (entity.hide_rules ?? []).map((row) => ({
        name: row.name ?? '',
        enabled: row.enabled,
        days: (row.days ?? []).map((day) => Number(day)),
        from: row.from,
        to: row.to,
        allCameras: row.all_cameras,
        cameraIds: row.camera_ids ?? [],
      })),
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }

  static ruleToRow(rule: CctvHideRule): CctvHideRuleRow {
    return {
      name: rule.name,
      enabled: rule.enabled,
      days: rule.days,
      from: rule.from,
      to: rule.to,
      all_cameras: rule.allCameras,
      camera_ids: rule.cameraIds,
    };
  }
}
