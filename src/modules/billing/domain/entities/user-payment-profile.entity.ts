export interface UserPaymentProfileState {
  userId: string;
  billingPhone: string;
  billingAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Provider-neutral private billing details saved by a payer.
 *
 * This profile is global to the user, not a kindergarten tenant. Updating the
 * billing phone never changes the login identity in users.phone.
 */
export class UserPaymentProfile {
  private constructor(private state: UserPaymentProfileState) {}

  static fromState(state: UserPaymentProfileState): UserPaymentProfile {
    return new UserPaymentProfile({ ...state });
  }

  toState(): UserPaymentProfileState {
    return { ...this.state };
  }

  get userId(): string {
    return this.state.userId;
  }

  get billingPhone(): string {
    return this.state.billingPhone;
  }

  get billingAddress(): string {
    return this.state.billingAddress;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  update(billingPhone: string, billingAddress: string, updatedAt: Date): void {
    this.state.billingPhone = billingPhone;
    this.state.billingAddress = billingAddress;
    this.state.updatedAt = updatedAt;
  }
}
