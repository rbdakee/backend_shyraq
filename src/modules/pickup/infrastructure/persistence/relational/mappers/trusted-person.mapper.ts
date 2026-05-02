import { TrustedPerson } from '../../../../domain/entities/trusted-person.entity';
import { TrustedPersonTypeOrmEntity } from '../entities/trusted-person.typeorm.entity';

/**
 * Domain ↔ persistence mapper for the TrustedPerson aggregate. Lives in the
 * relational subtree because it knows the TypeORM-entity shape; the
 * domain/application layers do not.
 */
export class TrustedPersonMapper {
  static toDomain(entity: TrustedPersonTypeOrmEntity): TrustedPerson {
    return TrustedPerson.fromState({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      childId: entity.child_id,
      addedByUserId: entity.added_by_user_id,
      fullName: entity.full_name,
      phone: entity.phone,
      iin: entity.iin,
      relation: entity.relation,
      photoUrl: entity.photo_url,
      isActive: entity.is_active,
      isOneTime: entity.is_one_time,
      usedAt: entity.used_at,
      createdAt: entity.created_at,
      revokedAt: entity.revoked_at,
    });
  }

  static toPersistence(domain: TrustedPerson): TrustedPersonTypeOrmEntity {
    const e = new TrustedPersonTypeOrmEntity();
    e.id = domain.id;
    e.kindergarten_id = domain.kindergartenId;
    e.child_id = domain.childId;
    e.added_by_user_id = domain.addedByUserId;
    e.full_name = domain.fullName;
    e.phone = domain.phone;
    e.iin = domain.iin;
    e.relation = domain.relation;
    e.photo_url = domain.photoUrl;
    e.is_active = domain.isActive;
    e.is_one_time = domain.isOneTime;
    e.used_at = domain.usedAt;
    e.created_at = domain.createdAt;
    e.revoked_at = domain.revokedAt;
    return e;
  }
}
