/**
 * SMS templates owned by the pickup module (B11). Kept module-local rather
 * than promoted to a shared file because the auth module's "OTP for login"
 * template is inline today and the only cross-module template need is the
 * pickup OTP — sharing a `welcome-sms.templates.ts` would create a 1:1
 * coupling for no benefit.
 *
 * Russian text is the source of truth for the demo SMS body. Future i18n
 * (kk, en) lands when SmsPort grows multi-locale support; for now the body
 * is fixed-language to keep the trusted-person experience unambiguous.
 */
export function pickupOtpTemplate(
  code: string,
  childName: string,
  kindergartenName: string,
): string {
  return `Shyraq: код для забора ребёнка ${childName} из ${kindergartenName}: ${code}. Сообщите код сотруднику.`;
}
