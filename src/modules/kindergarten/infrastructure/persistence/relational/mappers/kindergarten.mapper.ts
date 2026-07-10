import { Kindergarten } from '../../../../domain/entities/kindergarten.entity';
import { KindergartenEntity } from '../entities/kindergarten.entity';

export class KindergartenMapper {
  static toDomain(entity: KindergartenEntity): Kindergarten {
    return Kindergarten.hydrate({
      id: entity.id,
      name: entity.name,
      slug: entity.slug,
      address: entity.address,
      phone: entity.phone,
      logoUrl: entity.logo_url,
      plan: entity.plan,
      settings: entity.settings ?? {},
      isActive: entity.is_active,
      archivedAt: entity.archived_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
