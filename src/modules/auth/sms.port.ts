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
}
