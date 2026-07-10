import { SpecialistType } from './domain/entities/specialist-type.entity';
import { SpecialistTypeResponseDto } from './dto/specialist-type-response.dto';

export const SpecialistTypePresenter = {
  one(entity: SpecialistType): SpecialistTypeResponseDto {
    const s = entity.toState();
    return {
      id: s.id,
      code: s.code,
      name_i18n: s.nameI18n,
      is_system: s.isSystem,
      is_active: s.isActive,
      sort_order: s.sortOrder,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  many(entities: SpecialistType[]): SpecialistTypeResponseDto[] {
    return entities.map((e) => SpecialistTypePresenter.one(e));
  },
};
