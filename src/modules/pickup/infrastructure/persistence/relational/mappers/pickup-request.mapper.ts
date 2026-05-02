import { PickupRequest } from '../../../../domain/entities/pickup-request.entity';
import { PickupRequestTypeOrmEntity } from '../entities/pickup-request.typeorm.entity';

/**
 * Domain ↔ persistence mapper for the PickupRequest aggregate. Lives in the
 * relational subtree because it knows the TypeORM-entity shape; the
 * domain/application layers do not.
 */
export class PickupRequestMapper {
  static toDomain(entity: PickupRequestTypeOrmEntity): PickupRequest {
    return PickupRequest.fromState({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      childId: entity.child_id,
      requestedByUserId: entity.requested_by_user_id,
      trustedPersonId: entity.trusted_person_id,
      trustedPersonPhone: entity.trusted_person_phone,
      trustedPersonName: entity.trusted_person_name,
      trustedPersonIin: entity.trusted_person_iin,
      otpRef: entity.otp_ref,
      status: entity.status,
      validatedBy: entity.validated_by,
      validatedAt: entity.validated_at,
      attendanceEventId: entity.attendance_event_id,
      parentRequestId: entity.parent_request_id,
      expiresAt: entity.expires_at,
      createdAt: entity.created_at,
    });
  }

  static toPersistence(domain: PickupRequest): PickupRequestTypeOrmEntity {
    const e = new PickupRequestTypeOrmEntity();
    e.id = domain.id;
    e.kindergarten_id = domain.kindergartenId;
    e.child_id = domain.childId;
    e.requested_by_user_id = domain.requestedByUserId;
    e.trusted_person_id = domain.trustedPersonId;
    e.trusted_person_phone = domain.trustedPersonPhone;
    e.trusted_person_name = domain.trustedPersonName;
    e.trusted_person_iin = domain.trustedPersonIin;
    e.otp_ref = domain.otpRef;
    e.status = domain.status;
    e.validated_by = domain.validatedBy;
    e.validated_at = domain.validatedAt;
    e.attendance_event_id = domain.attendanceEventId;
    e.parent_request_id = domain.parentRequestId;
    e.expires_at = domain.expiresAt;
    e.created_at = domain.createdAt;
    return e;
  }
}
