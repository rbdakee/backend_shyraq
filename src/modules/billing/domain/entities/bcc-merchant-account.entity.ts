import { BccMerchantAccountActivationError } from '../errors/bcc-merchant-account-activation.error';
import { BccMerchantAccountStatusInvalidError } from '../errors/bcc-merchant-account-status-invalid.error';

export type BccEnvironment = 'test' | 'live';
export type BccMerchantAccountStatus = 'draft' | 'active' | 'disabled';

/**
 * Sanitized result of a BCC TRTYPE=800 connection check.
 * Secrets and full request/response payloads never belong in this object.
 */
export interface BccConnectionResult {
  success: boolean;
  action: string | null;
  rc: string | null;
  rcText: string | null;
}

export interface BccMerchantAccountState {
  id: string;
  kindergartenId: string;
  merchantId: string;
  terminalId: string;
  merchantName: string | null;
  /** AES-GCM ciphertext produced by CryptoCipherPort. */
  macKeyEnc: string;
  environment: BccEnvironment;
  status: BccMerchantAccountStatus;
  /** Lowercase SHA-256 hex. The plaintext token is never persisted. */
  callbackTokenHash: string;
  notifyUsername: string;
  /** One-way password hash. The plaintext password is never persisted. */
  notifyPasswordHash: string;
  lastConnectionCheckedAt: Date | null;
  lastConnectionResult: BccConnectionResult | null;
  disabledAt: Date | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Per-kindergarten BCC merchant account.
 *
 * Lifecycle:
 *   draft --successful TRTYPE=800 + activate--> active
 *   active ------------------------------disable--> disabled
 *   disabled --new successful check + activate----> active
 *
 * Encrypted and hashed credentials remain opaque to the aggregate.
 */
export class BccMerchantAccount {
  private constructor(private state: BccMerchantAccountState) {}

  static fromState(state: BccMerchantAccountState): BccMerchantAccount {
    return new BccMerchantAccount({
      ...state,
      lastConnectionResult: state.lastConnectionResult
        ? { ...state.lastConnectionResult }
        : null,
    });
  }

  toState(): BccMerchantAccountState {
    return {
      ...this.state,
      lastConnectionResult: this.state.lastConnectionResult
        ? { ...this.state.lastConnectionResult }
        : null,
    };
  }

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get status(): BccMerchantAccountStatus {
    return this.state.status;
  }

  get environment(): BccEnvironment {
    return this.state.environment;
  }

  get merchantId(): string {
    return this.state.merchantId;
  }

  get terminalId(): string {
    return this.state.terminalId;
  }

  get merchantName(): string | null {
    return this.state.merchantName;
  }

  get macKeyEnc(): string {
    return this.state.macKeyEnc;
  }

  get callbackTokenHash(): string {
    return this.state.callbackTokenHash;
  }

  get notifyUsername(): string {
    return this.state.notifyUsername;
  }

  get notifyPasswordHash(): string {
    return this.state.notifyPasswordHash;
  }

  get lastConnectionCheckedAt(): Date | null {
    return this.state.lastConnectionCheckedAt;
  }

  get lastConnectionResult(): BccConnectionResult | null {
    return this.state.lastConnectionResult
      ? { ...this.state.lastConnectionResult }
      : null;
  }

  get disabledAt(): Date | null {
    return this.state.disabledAt;
  }

  get updatedBy(): string {
    return this.state.updatedBy;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  isActive(): boolean {
    return this.state.status === 'active';
  }

  recordConnectionCheck(
    result: BccConnectionResult,
    checkedAt: Date,
    updatedBy: string,
  ): void {
    this.state.lastConnectionResult = { ...result };
    this.state.lastConnectionCheckedAt = checkedAt;
    this.state.updatedBy = updatedBy;
    this.state.updatedAt = checkedAt;
  }

  activate(now: Date, updatedBy: string): void {
    if (this.state.status === 'active') {
      throw new BccMerchantAccountStatusInvalidError('active', 'activate');
    }

    const checkedAt = this.state.lastConnectionCheckedAt;
    const hasSuccessfulCheck =
      this.state.lastConnectionResult?.success === true && checkedAt !== null;
    const checkIsAfterDisable =
      this.state.disabledAt === null ||
      (checkedAt !== null &&
        checkedAt.getTime() > this.state.disabledAt.getTime());

    if (!hasSuccessfulCheck || !checkIsAfterDisable) {
      throw new BccMerchantAccountActivationError();
    }

    this.state.status = 'active';
    this.state.disabledAt = null;
    this.state.updatedBy = updatedBy;
    this.state.updatedAt = now;
  }

  /** Disables new BCC payments without deleting credentials or history. */
  disable(now: Date, updatedBy: string): void {
    if (this.state.status === 'disabled') return;

    this.state.status = 'disabled';
    this.state.disabledAt = now;
    this.state.updatedBy = updatedBy;
    this.state.updatedAt = now;
  }
}
