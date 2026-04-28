export class OtpLockedError extends Error {
  readonly code = 'otp_locked';
  constructor() {
    super('otp_locked');
    this.name = 'OtpLockedError';
  }
}
