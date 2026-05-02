import { PickupRequest } from './domain/entities/pickup-request.entity';
import { TrustedPerson } from './domain/entities/trusted-person.entity';
import {
  PickupRequestResponseDto,
  SendPickupOtpResponseDto,
  ValidatePickupOtpResponseDto,
} from './dto/pickup-request-response.dto';
import { TrustedPersonResponseDto } from './dto/trusted-person-response.dto';

/**
 * Domain → response-DTO mappers for the pickup module. Pure (no Nest /
 * TypeORM imports) so controllers stay thin and assertions in
 * service-unit specs can reuse the same shapes.
 *
 * snake_case wire keys per the project endpoints.md convention; presenter
 * does the conversion from camelCase domain state.
 */
export const PickupPresenter = {
  pickupRequest(pr: PickupRequest): PickupRequestResponseDto {
    const s = pr.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      requested_by_user_id: s.requestedByUserId,
      trusted_person_id: s.trustedPersonId,
      trusted_person_name: s.trustedPersonName,
      trusted_person_phone: s.trustedPersonPhone,
      trusted_person_iin: s.trustedPersonIin,
      otp_ref: s.otpRef,
      status: s.status,
      validated_by: s.validatedBy,
      validated_at: s.validatedAt ? s.validatedAt.toISOString() : null,
      attendance_event_id: s.attendanceEventId,
      parent_request_id: s.parentRequestId,
      expires_at: s.expiresAt.toISOString(),
      created_at: s.createdAt.toISOString(),
    };
  },

  trustedPerson(tp: TrustedPerson): TrustedPersonResponseDto {
    const s = tp.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      added_by_user_id: s.addedByUserId,
      full_name: s.fullName,
      phone: s.phone,
      iin: s.iin,
      relation: s.relation,
      photo_url: s.photoUrl,
      is_active: s.isActive,
      is_one_time: s.isOneTime,
      used_at: s.usedAt ? s.usedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
      revoked_at: s.revokedAt ? s.revokedAt.toISOString() : null,
    };
  },

  sendOtp(input: {
    otpRef: string;
    expiresIn: number;
  }): SendPickupOtpResponseDto {
    return { otp_ref: input.otpRef, expires_in: input.expiresIn };
  },

  validateOtp(input: {
    pickupRequest: PickupRequest;
    attendanceEventId: string;
  }): ValidatePickupOtpResponseDto {
    return {
      pickup_request: PickupPresenter.pickupRequest(input.pickupRequest),
      attendance_event_id: input.attendanceEventId,
    };
  },
};
