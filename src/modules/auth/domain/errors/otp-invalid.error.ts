export class OtpInvalidError extends Error {
  readonly code = 'invalid_otp';
  constructor() {
    super('invalid_otp');
    this.name = 'OtpInvalidError';
  }
}
