export type SmsProvider = 'mock' | 'whatsapp';

export type WhatsAppOtpTemplateConfig = {
  /** Approved template name in Meta Business Manager (e.g. `otp_ru`). */
  name: string;
  /** BCP-47 language code matching the template language (e.g. `ru`). */
  language: string;
  /**
   * `true` when the template includes a one-tap/copy-code button. Meta's
   * Authentication-category templates default to having one — the API then
   * requires the code passed BOTH in the body parameter AND in the button
   * parameter. Set `false` only for body-only templates.
   */
  hasButton: boolean;
};

export type WhatsAppConfig = {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
  businessAccountId: string | null;
  otpTemplate: WhatsAppOtpTemplateConfig;
  /** Named-parameter Utility templates (all language `templateLanguage`). */
  templates: {
    adminInvite: string;
    staffInvite: string;
    trustedPersonAssigned: string;
    pickupOtp: string;
  };
  /** BCP-47 language code shared by the named-parameter templates above. */
  templateLanguage: string;
  /**
   * Sandbox-only override (Meta dashboard bug workaround). When set AND
   * NODE_ENV !== 'production', every outgoing message is re-routed to this
   * raw wa_id (digits only).
   *
   * Required ONLY for Meta test-sandbox numbers (the +1 555… numbers handed
   * out before a real WABA is provisioned), where recipients are managed via
   * a 5-entry whitelist in the Meta dashboard. The dashboard UI silently
   * inserts the Kazakh/Russian local trunk-prefix `8` when verifying +7
   * numbers, storing e.g. `787772270088` in the whitelist instead of the
   * correct E.164 wa_id `77772270088`. Meta's whitelist matcher is a literal
   * string compare (not wa_id normalization), so a correctly-normalized
   * send is rejected with code 131030 even though the wa_id resolves to the
   * same recipient. Setting this override re-routes sends to the literal
   * string Meta has whitelisted.
   *
   * Production / real-number WABA: leave NULL. Real numbers have no whitelist
   * and Meta normalizes wa_ids consistently — confirmed working end-to-end
   * on +7 706 653 6188 → +7 777 227 0088 with no override.
   */
  devRecipientOverride: string | null;
};

export type AuthConfig = {
  jwtAccessSecret: string;
  jwtAccessTtl: string;
  refreshTokenTtlDays: number;
  bcryptCost: number;
  otpLength: number;
  otpTtlSeconds: number;
  rateLimitOtpRequestLimit: number;
  rateLimitOtpRequestWindowSec: number;
  rateLimitSuperAdminLoginLimit: number;
  rateLimitSuperAdminLoginWindowSec: number;
  rateLimitParentLinkLimit: number;
  rateLimitParentLinkWindowSec: number;
  otpTestPhones: string;
  otpTestCode: string;
  smsProvider: SmsProvider;
  whatsapp: WhatsAppConfig | null;
};
