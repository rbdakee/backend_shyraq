import { SpecialistType } from '../../../../domain/entities/specialist-type.entity';
import type { SpecialistTypeLabels } from '../../../../domain/system-defaults';
import { SpecialistTypeEntity } from '../entities/specialist-type.entity';

export class SpecialistTypeMapper {
  static toDomain(entity: SpecialistTypeEntity): SpecialistType {
    return SpecialistType.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      code: entity.code,
      nameI18n: (entity.name_i18n ?? {}) as SpecialistTypeLabels,
      isSystem: entity.is_system,
      isActive: entity.is_active,
      sortOrder: entity.sort_order,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
