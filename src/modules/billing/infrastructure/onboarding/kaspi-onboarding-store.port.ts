/**
 * In-flight onboarding state threaded between the 3 SMS steps (init →
 * send-phone → verify-otp). Keyed by Kaspi `processId` in Redis with a 300s
 * TTL (a partially-completed onboarding self-expires — the admin restarts via
 * /init).
 *
 * ⚠️ This blob holds the per-tenant device ECDSA PRIVATE key (pkcs8 DER) for up
 * to 5 minutes so the `finish` step can sign with it. The adapter therefore
 * encrypts the whole blob with `CryptoCipherPort` (AES-256-GCM) before writing
 * to Redis — defence-in-depth so a Redis dump never leaks a signing key.
 */
export interface KaspiOnboardingState {
  /** The kindergarten this onboarding belongs to (re-checked on each step). */
  kindergartenId: string;
  /** The admin user who started the onboarding. */
  connectedByUserId: string;
  /** Kaspi process id (`meta.pId`) — also the Redis key. */
  processId: string;
  /** Rotating `user_token` cookie value threaded between steps. */
  userToken: string | null;
  /** Cashier phone captured at send-phone. */
  phoneNumber: string | null;

  // ── Per-tenant device fingerprint (generated fresh at /init) ──────────────
  deviceId: string;
  installId: string;
  pinHash: string;
  /** `pk` cookie value — base64 of the uncompressed EC point (last 65 DER bytes). */
  pk: string;
  /** `pkTag` cookie/header value — md5 hex of `pk`. */
  pkTag: string;
  /** Device ECDSA P-256 private key, pkcs8 DER base64 (used to sign `finish`). */
  devicePrivateKeyDerB64: string;
  /** Device ECDSA P-256 public key, spki DER base64. */
  devicePublicKeyDerB64: string;
}

/**
 * Port for the Redis-backed in-flight onboarding store. Abstract class used
 * directly as the DI token (per CLAUDE.md §4). NEVER an in-memory Map — the
 * onboarding spans multiple HTTP requests and must survive across instances.
 */
export abstract class KaspiOnboardingStorePort {
  /** Persists the in-flight state under its processId with a 300s TTL. */
  abstract put(state: KaspiOnboardingState): Promise<void>;

  /** Loads the in-flight state by processId, or null if absent/expired. */
  abstract get(processId: string): Promise<KaspiOnboardingState | null>;

  /** Deletes the in-flight state (called after a successful finish). */
  abstract delete(processId: string): Promise<void>;
}
