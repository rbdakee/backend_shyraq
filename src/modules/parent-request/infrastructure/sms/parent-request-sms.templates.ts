/**
 * SMS templates owned by the parent-request module (B12). Mirrors the pickup
 * module's `pickup-otp-template` style — pure function, Russian copy is the
 * source of truth for the demo.
 *
 * Currently only `trusted_person` flows generate an OTP; future request types
 * (e.g. high-risk operations) can extend `RequestType` without changing the
 * function signature.
 */
export type ParentRequestOtpType = 'trusted_person';

export function parentRequestOtpTemplate(
  code: string,
  requestType: ParentRequestOtpType,
): string {
  switch (requestType) {
    case 'trusted_person':
    default:
      return `Shyraq: код подтверждения для добавления доверенного лица: ${code}. Срок действия — 5 минут.`;
  }
}
