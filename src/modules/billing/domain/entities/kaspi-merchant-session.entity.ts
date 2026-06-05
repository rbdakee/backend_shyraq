export type KaspiSessionStatus = 'pending' | 'active' | 'expired' | 'revoked';

/**
 * Persisted state of a `kaspi_merchant_session` row. One row per kindergarten
 * (UNIQUE on kindergarten_id). All `*Enc` fields are AES-256-GCM blobs produced
 * by `CryptoCipherPort` — the domain treats them as opaque base64 strings and
 * NEVER decrypts them (decryption lives in the service, just-in-time, for the
 * Kaspi HTTP calls only).
 */
export interface KaspiMerchantSessionState {
  id: string;
  kindergartenId: string;
  connectedByUserId: string;
  status: KaspiSessionStatus;
  cashierPhone: string | null;
  kaspiProfileId: string | null;
  kaspiOrgId: string | null;
  orgName: string | null;
  /** vtoken serial number (sensitive — not a secret per se, but never echoed). */
  tokenSn: string | null;
  /** AES-GCM blob of the raw ECDH shared secret (the vtoken MAC key). */
  vtokenSecretEnc: string | null;
  /** AES-GCM blob of the device ECDSA P-256 keypair (pkcs8+spki DER, JSON). */
  deviceKeypairEnc: string | null;
  /** AES-GCM blob of the ECDH P-256 keypair generated at finish (pkcs8+spki DER, JSON). */
  ecdhKeypairEnc: string | null;
  deviceId: string | null;
  installId: string | null;
  pinHash: string | null;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fields needed to mark a freshly-onboarded session active. Bundled into one
 * object so the state machine activates atomically (all encrypted creds + the
 * device fingerprint + org context land together).
 */
export interface KaspiSessionActivation {
  cashierPhone: string;
  kaspiProfileId: string | null;
  kaspiOrgId: string | null;
  orgName: string | null;
  tokenSn: string;
  vtokenSecretEnc: string;
  deviceKeypairEnc: string;
  ecdhKeypairEnc: string;
  deviceId: string;
  installId: string;
  pinHash: string;
}

/**
 * KaspiMerchantSession aggregate (B24 / K5). Owns the onboarding state machine:
 *
 *   pending  ──activate──►  active
 *   active   ──markExpired──► expired   (K8 poller on session_expired)
 *   expired  ──activate──►  active      (refresh / re-onboarding)
 *   *        ──revoke──►    revoked      (admin disconnect)
 *
 * `revoked` is terminal for the lifecycle, but a kindergarten may re-onboard,
 * which OVERWRITES the single row (UNIQUE kindergarten_id) rather than inserting
 * a new one — so the service treats re-onboarding as an upsert, not a transition.
 *
 * The aggregate never decrypts the `*Enc` blobs; it holds them opaquely.
 */
export class KaspiMerchantSession {
  private constructor(private state: KaspiMerchantSessionState) {}

  static fromState(s: KaspiMerchantSessionState): KaspiMerchantSession {
    return new KaspiMerchantSession({ ...s });
  }

  toState(): KaspiMerchantSessionState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get status(): KaspiSessionStatus {
    return this.state.status;
  }

  get cashierPhone(): string | null {
    return this.state.cashierPhone;
  }

  get orgName(): string | null {
    return this.state.orgName;
  }

  get kaspiProfileId(): string | null {
    return this.state.kaspiProfileId;
  }

  get kaspiOrgId(): string | null {
    return this.state.kaspiOrgId;
  }

  get tokenSn(): string | null {
    return this.state.tokenSn;
  }

  get vtokenSecretEnc(): string | null {
    return this.state.vtokenSecretEnc;
  }

  get deviceKeypairEnc(): string | null {
    return this.state.deviceKeypairEnc;
  }

  get ecdhKeypairEnc(): string | null {
    return this.state.ecdhKeypairEnc;
  }

  get installId(): string | null {
    return this.state.installId;
  }

  get deviceId(): string | null {
    return this.state.deviceId;
  }

  get pinHash(): string | null {
    return this.state.pinHash;
  }

  get lastCheckedAt(): Date | null {
    return this.state.lastCheckedAt;
  }

  // ── predicates ─────────────────────────────────────────────────────────

  isActive(): boolean {
    return this.state.status === 'active';
  }

  // ── transitions ────────────────────────────────────────────────────────

  /**
   * `pending | expired → active`. Stamps all credential + org-context fields
   * in one shot. Called after a successful finish + org-context exchange.
   */
  activate(activation: KaspiSessionActivation, now: Date): void {
    this.state.status = 'active';
    this.state.cashierPhone = activation.cashierPhone;
    this.state.kaspiProfileId = activation.kaspiProfileId;
    this.state.kaspiOrgId = activation.kaspiOrgId;
    this.state.orgName = activation.orgName;
    this.state.tokenSn = activation.tokenSn;
    this.state.vtokenSecretEnc = activation.vtokenSecretEnc;
    this.state.deviceKeypairEnc = activation.deviceKeypairEnc;
    this.state.ecdhKeypairEnc = activation.ecdhKeypairEnc;
    this.state.deviceId = activation.deviceId;
    this.state.installId = activation.installId;
    this.state.pinHash = activation.pinHash;
    this.state.lastCheckedAt = now;
    this.state.updatedAt = now;
  }

  /**
   * `active → expired`. Used by the K8 poller when Kaspi reports the session
   * needs a refresh. Re-credentialing after refresh re-activates the row.
   */
  markExpired(now: Date): void {
    this.state.status = 'expired';
    this.state.lastCheckedAt = now;
    this.state.updatedAt = now;
  }

  /**
   * Rotates the credentials after a successful SignInLite refresh while keeping
   * the session active. The device fingerprint and ECDH keypair are unchanged
   * (refresh reuses the stored ECDH keypair), only tokenSn + vtoken secret and
   * the org context may change.
   */
  applyRefresh(
    params: {
      tokenSn: string;
      vtokenSecretEnc: string;
      kaspiProfileId: string | null;
      kaspiOrgId: string | null;
      orgName: string | null;
    },
    now: Date,
  ): void {
    this.state.status = 'active';
    this.state.tokenSn = params.tokenSn;
    this.state.vtokenSecretEnc = params.vtokenSecretEnc;
    if (params.kaspiProfileId !== null)
      this.state.kaspiProfileId = params.kaspiProfileId;
    if (params.kaspiOrgId !== null) this.state.kaspiOrgId = params.kaspiOrgId;
    if (params.orgName !== null) this.state.orgName = params.orgName;
    this.state.lastCheckedAt = now;
    this.state.updatedAt = now;
  }

  /** `* → revoked` (admin disconnect). Idempotent. */
  revoke(now: Date): void {
    this.state.status = 'revoked';
    this.state.updatedAt = now;
  }
}
