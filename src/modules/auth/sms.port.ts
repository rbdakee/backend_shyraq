export interface SmsSendResult {
  txnId: string;
}

export abstract class SmsPort {
  abstract send(phone: string, message: string): Promise<SmsSendResult>;

  /**
   * Deliver an OTP code via a provider-side approved template (WhatsApp
   * Authentication category template, SMS Verify API, etc.). Required for
   * channels with cold-recipient restrictions — WhatsApp freeform `send`
   * rejects with code 131047 when the recipient hasn't messaged the business
   * number within the past 24h, but template sends bypass that window.
   */
  abstract sendOtp(phone: string, code: string): Promise<SmsSendResult>;

  /**
   * Template `admin_invite_ru` (named param `kg_name`). Also used for the
   * new-kindergarten admin welcome — same template, same single param.
   */
  abstract sendAdminInvite(
    phone: string,
    kindergartenName: string,
  ): Promise<SmsSendResult>;

  /** Template `staff_invite_ru` (named param `kg_name`). */
  abstract sendStaffInvite(
    phone: string,
    kindergartenName: string,
  ): Promise<SmsSendResult>;

  /**
   * Template `trusted_person_assigned_ru` (named params `child_name`,
   * `kg_name`). Sent to the trusted person when an admin accepts a
   * trusted_person request.
   */
  abstract sendTrustedPersonAssigned(
    phone: string,
    childName: string,
    kindergartenName: string,
  ): Promise<SmsSendResult>;

  /**
   * Template `pickup_otp_ru` (named params `child_name`, `kg_name`, `otp`).
   * Pickup code delivered to a trusted person (B11).
   */
  abstract sendPickupOtp(
    phone: string,
    childName: string,
    kindergartenName: string,
    code: string,
  ): Promise<SmsSendResult>;
}
