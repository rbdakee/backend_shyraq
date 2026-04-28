export class OtpExpiredError extends Error {
  readonly code = 'otp_expired_or_missing';
  constructor() {
    super('otp_expired_or_missing');
    this.name = 'OtpExpiredError';
  }
}
