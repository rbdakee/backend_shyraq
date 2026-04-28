export class OtpRateLimitedError extends Error {
  readonly code = 'otp_rate_limit';
  constructor() {
    super('otp_rate_limit');
    this.name = 'OtpRateLimitedError';
  }
}
