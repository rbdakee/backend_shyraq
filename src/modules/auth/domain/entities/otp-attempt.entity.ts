export const MAX_OTP_ATTEMPTS = 3;

export interface OtpAttemptState {
  phone: string;
  code: string;
  attempts: number;
}

/**
 * Pure-domain POJO around a phone's OTP state in flight. Redis holds the
 * actual bytes; this entity captures the rule around lockout after N wrong
 * codes. Kept deliberately passive — the use-case drives state transitions,
 * the entity gate-keeps the invariant.
 */
export class OtpAttempt {
  private constructor(
    readonly phone: string,
    readonly code: string,
    private _attempts: number,
  ) {}

  static hydrate(state: OtpAttemptState): OtpAttempt {
    if (state.attempts < 0) {
      throw new Error('OtpAttempt.attempts must be >= 0');
    }
    return new OtpAttempt(state.phone, state.code, state.attempts);
  }

  get attempts(): number {
    return this._attempts;
  }

  matches(submitted: string): boolean {
    return this.code === submitted;
  }

  /**
   * Register a wrong guess locally. Caller is responsible for persisting.
   * Returns true if this increment crossed the lockout threshold.
   */
  registerWrongAttempt(): boolean {
    this._attempts += 1;
    return this._attempts >= MAX_OTP_ATTEMPTS;
  }
}
