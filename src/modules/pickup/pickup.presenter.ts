import { maskKzPhone } from '@/shared-kernel/utils/phone-mask';
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
    // T7-4 LOW: `otp_ref` (Redis key namespace) is intentionally NOT
    // surfaced on list/get/create/cancel responses — it's an internal
    // cache implementation detail. The dedicated `SendPickupOtpResponseDto`
    // still returns it as auditable info for the calling staff.
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      requested_by_user_id: s.requestedByUserId,
      trusted_person_id: s.trustedPersonId,
      trusted_person_name: s.trustedPersonName,
      trusted_person_phone: s.trustedPersonPhone,
      trusted_person_iin: s.trustedPersonIin,
      status: s.status,
      validated_by: s.validatedBy,
      validated_at: s.validatedAt ? s.validatedAt.toISOString() : null,
      attendance_event_id: s.attendanceEventId,
      parent_request_id: s.parentRequestId,
      expires_at: s.expiresAt.toISOString(),
      created_at: s.createdAt.toISOString(),
    };
  },

  /**
   * List-shaped variant of `pickupRequest` — identical shape, but
   * `trusted_person_phone` is masked to `+7***LAST4`. Single-get
   * (`GET /staff/pickup-requests/:id`) intentionally keeps the full
   * phone available for staff who need to actually call the trusted
   * person; the list endpoint reduces the surface so a casual
   * dashboard scroll does not enumerate every contact.
   *
   * Closes FINDINGS B11 H4 (B22a T8).
   */
  pickupRequestForList(pr: PickupRequest): PickupRequestResponseDto {
    const dto = PickupPresenter.pickupRequest(pr);
    return {
      ...dto,
      trusted_person_phone: maskKzPhone(dto.trusted_person_phone),
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
