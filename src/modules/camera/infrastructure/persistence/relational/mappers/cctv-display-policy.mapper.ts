import { CctvDisplayPolicy } from '../../../../domain/entities/cctv-display-policy.entity';
import { CctvDisplayPolicyEntity } from '../entities/cctv-display-policy.entity';

export class CctvDisplayPolicyMapper {
  static toDomain(entity: CctvDisplayPolicyEntity): CctvDisplayPolicy {
    return CctvDisplayPolicy.hydrate({
      kindergartenId: entity.kindergarten_id,
      // smallint[] arrives as string[] under some pg driver versions; the
      // domain wants numbers and would reject '1' as a weekday.
      workDays: (entity.work_days ?? []).map((day) => Number(day)),
      opensAt: entity.opens_at,
      closesAt: entity.closes_at,
      workHours: {
        mode: entity.work_hours_mode,
        cameraIds: entity.work_hours_camera_ids ?? [],
      },
      offHours: {
        mode: entity.off_hours_mode,
        cameraIds: entity.off_hours_camera_ids ?? [],
      },
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
