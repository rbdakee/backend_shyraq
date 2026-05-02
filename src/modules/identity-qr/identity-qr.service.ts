import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { RefreshTokenRepository } from '@/modules/auth/infrastructure/persistence/refresh-token.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { User } from '@/modules/users/domain/entities/user.entity';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { QrToken } from './domain/entities/qr-token.entity';
import { QrScanRateLimitExceededError } from './domain/errors/qr-scan-rate-limit-exceeded.error';
import { QrTokenExpiredError } from './domain/errors/qr-token-expired.error';
import { QrTokenNotFoundError } from './domain/errors/qr-token-not-found.error';
import { QrTokenRevokedError } from './domain/errors/qr-token-revoked.error';
import { QrTokenCachePort } from './infrastructure/cache/qr-token-cache.port';
import { IdentityQrRepository } from './infrastructure/persistence/identity-qr.repository';
import { QrScanRateLimiterPort } from './infrastructure/rate-limit/qr-scan-rate-limiter.port';

const TTL_SECONDS = 24 * 60 * 60;
const TOKEN_BYTES = 16; // → 32 hex chars
/**
 * Reuse threshold — if the active row's `expires_at - now` is less than
 * this, the next `GET /users/me/qr` mints fresh instead of returning the
 * existing token. Locked at 1h in `replicated-rolling-blum.md` §1.
 */
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

export interface IssueOrRefreshResult {
  token: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface ScanResult {
  user: User;
  role: string;
  linkedChildren?: Child[];
  allowedActions: string[];
}

export interface RevokeAllResult {
  revokedCount: number;
}

/**
 * IdentityQrService — orchestrates the B10 Identity-QR flow.
 *
 * Three public methods, each mapping 1:1 to a controller endpoint:
 *
 *   issueOrRefresh(userId)
 *     — reuse-or-mint. Reuse path: if the user-keyed cache holds a
 *       plaintext AND the matching DB row is active AND `expires_at - now`
 *       is over the 1h refresh threshold, return the cached plaintext (no
 *       DB write, no cache write). Mint path: revoke any active rows,
 *       insert a fresh row, write both `qr:token:{plaintext}` and
 *       `qr:user:{userId}:identity` cache entries. Both paths run inside
 *       the ambient TX (TenantContextInterceptor) and start with a
 *       per-user pg_advisory_xact_lock so concurrent calls serialize and
 *       converge on a single mint. Cross-tenant — `user_qr_tokens` has no
 *       RLS by design (a parent guardianship may span multiple
 *       kindergartens, the QR is the user's identity, not a per-kg token).
 *
 *   scan(callerUserId, deviceId, plaintext)
 *     — 5-step: (1) verify caller's refresh-token session is bound to
 *       `deviceId` (otherwise the rate-limit could be trivially bypassed by
 *       rotating the X-Device-Id header); (2) per-device fixed-window rate
 *       limit (60 / 60s); (3) Redis cache lookup → user_id; (4) DB recheck
 *       (existence, expiry, revoked, owner) — Redis is best-effort, DB is
 *       SoT; (5) hydrate the scanned user + role-derived
 *       `allowed_actions` + (parent-only) `linked_children`. On success
 *       stamps `last_scanned_at`.
 *
 *   revokeAllByUser(adminUserId, targetUserId)
 *     — bulk-stamps `revoked_at` on every active row for the target user
 *       AND clears the user-keyed reuse cache (`qr:user:{userId}:identity`)
 *       so the user's next GET mints fresh instead of returning the
 *       just-revoked plaintext. The plaintext-keyed cache
 *       (`qr:token:{plaintext}`) cannot be cleared from this path (admin
 *       only has the hash, not the plaintext); it stays correct because
 *       `scan`'s DB-recheck still surfaces `qr_token_revoked` (410). Cache
 *       TTL ≤ 24h is the upper bound on stale plaintext-cache exposure.
 */
@Injectable()
export class IdentityQrService {
  private readonly logger = new Logger(IdentityQrService.name);

  constructor(
    private readonly qrRepo: IdentityQrRepository,
    private readonly cache: QrTokenCachePort,
    private readonly rateLimiter: QrScanRateLimiterPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly refreshTokenRepo: RefreshTokenRepository,
    private readonly childGuardianRepo: ChildGuardianRepository,
    private readonly childRepo: ChildRepository,
    private readonly staffMemberRepo: StaffMemberRepository,
    private readonly userRepo: UserRepository,
  ) {}

  // ── issueOrRefresh ───────────────────────────────────────────────────────

  /**
   * Reuse-or-mint the user's Identity QR.
   *
   * Reuse path: if the user-keyed cache holds an active plaintext and the
   * paired DB row is active AND `expires_at - now > REFRESH_THRESHOLD_MS`,
   * return the cached plaintext as-is. No DB write, no cache write.
   *
   * Mint path: any failure of the reuse precondition (cache miss, row
   * missing, row revoked, row expired, row near-expiry) falls through to
   * revoke-all-then-insert-new + sync both cache keys.
   *
   * Atomicity is provided by TenantContextInterceptor's ambient TX: the
   * interceptor opens a TX around every controller invocation and pushes
   * its EntityManager into `tenantStorage`; the QR repo's `manager()` helper
   * picks it up so the advisory lock + the optional revoke + insert all run
   * in the same TX.
   *
   * `acquireUserAdvisoryLock` serializes concurrent calls for the same user.
   * Without it, two simultaneous GETs would both see "no active row", both
   * run revoke-all (no-op), then race on INSERT — the partial unique idx
   * `(user_id, purpose) WHERE revoked_at IS NULL` rejects the second with
   * PG 23505 → 500. With the lock, the second caller blocks until the first
   * commits, then either reuses the just-minted token (cache populated by
   * the first caller) or revokes-and-mints cleanly.
   */
  async issueOrRefresh(userId: string): Promise<IssueOrRefreshResult> {
    const now = this.clock.now();

    await this.qrRepo.acquireUserAdvisoryLock(userId);

    // ── Reuse path ─────────────────────────────────────────────────────
    const cachedPlaintext = await this.cache.getUserActiveToken(userId);
    if (cachedPlaintext !== null) {
      const row = await this.qrRepo.findActiveByUserAndPurpose(
        userId,
        'identity',
        now,
      );
      if (row && !row.shouldRefresh(now, REFRESH_THRESHOLD_MS)) {
        // Defensive: the cached plaintext must hash to the active row.
        // A mismatch means stale Redis state (eviction collision or admin
        // revoke that cleared the user-key but not yet the row). Fall
        // through to mint instead of returning a stale token.
        if (sha256Hex(cachedPlaintext) === row.toState().tokenHash) {
          const state = row.toState();
          return {
            token: cachedPlaintext,
            issuedAt: state.issuedAt,
            expiresAt: state.expiresAt,
          };
        }
      }
    }

    // ── Mint path ──────────────────────────────────────────────────────
    const issuedAt = now;
    const expiresAt = new Date(now.getTime() + TTL_SECONDS * 1000);
    const plaintext = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = sha256Hex(plaintext);

    await this.qrRepo.revokeAllByUser(userId, 'identity', now);
    const token = QrToken.create({
      id: randomUUID(),
      userId,
      kindergartenId: null,
      purpose: 'identity',
      tokenHash,
      issuedAt,
      expiresAt,
    });
    await this.qrRepo.create(token);

    // Sync both Redis keys. Sequential SETs are fine: partial-state is
    // benign — if `setUserActiveToken` fails after `setToken` succeeded,
    // the next GET sees no user-key, mints fresh, and re-syncs; the
    // leftover `qr:token:{plaintext}` is harmless because the row will be
    // revoked on that next mint and `scan` re-checks the DB anyway.
    await this.cache.setToken(plaintext, userId, TTL_SECONDS);
    await this.cache.setUserActiveToken(userId, plaintext, TTL_SECONDS);

    return { token: plaintext, issuedAt, expiresAt };
  }

  // ── scan ────────────────────────────────────────────────────────────────

  async scan(
    callerUserId: string,
    deviceId: string,
    plaintextToken: string,
    scanningKgId: string | null,
  ): Promise<ScanResult> {
    const now = this.clock.now();

    // 1) Caller-session binding: prevent device-id spoofing on the rate-limit.
    const hasSession = await this.refreshTokenRepo.hasActiveSessionForDevice(
      callerUserId,
      deviceId,
      now,
    );
    if (!hasSession) {
      throw new UnauthorizedException('no_active_session_for_device');
    }

    // 2) Rate-limit (60/60s). Counts every call — including ones that would
    // ultimately fail for "not found" — to cap brute-force token guessing
    // at the same budget as legitimate scans.
    const rl = await this.rateLimiter.check(deviceId);
    if (!rl.ok) {
      throw new QrScanRateLimitExceededError(rl.retryAfterSeconds ?? 60);
    }

    // 3) Cache lookup. A miss does not mean "invalid": Redis can drop entries
    // (eviction, restart) while the DB row is still active. We treat the
    // cache as a fast-path optimization and always re-validate via the DB.
    const cachedUserId = await this.cache.lookup(plaintextToken);

    // 4) DB recheck — source of truth.
    const tokenHash = sha256Hex(plaintextToken);
    const row = await this.qrRepo.findByTokenHash(tokenHash);
    if (!row) {
      throw new QrTokenNotFoundError();
    }
    const state = row.toState();
    if (row.isRevoked()) {
      throw new QrTokenRevokedError();
    }
    if (row.isExpired(now)) {
      throw new QrTokenExpiredError();
    }
    // Defensive: if the cache hit returned a different user_id than the DB
    // row owns, treat as not-found rather than leak the DB state — likely a
    // cache poisoning attempt or a stale collision.
    if (cachedUserId !== null && cachedUserId !== state.userId) {
      throw new QrTokenNotFoundError();
    }

    // 5) Hydrate scanned user + role + (parent-only) linked children.
    const user = await this.userRepo.findById(state.userId);
    if (!user) {
      // The user was deleted but the row hasn't been cascaded yet — surface
      // as "not found" rather than 500 to keep the staff app robust.
      throw new QrTokenNotFoundError();
    }

    const { role, staffMembers, guardians } = await this.resolveRoleContext(
      state.userId,
      scanningKgId,
    );

    let linkedChildren: Child[] | undefined;
    if (role === 'parent') {
      // Children list is scoped to the scanning-staff's kg. The token
      // itself is cross-tenant (one parent → one QR across kindergartens),
      // but staff in kg-A must NOT see the parent's kg-B children. The
      // guardians array is already filtered by scanningKgId in
      // resolveRoleContext; here we just hydrate the corresponding kids.
      const childIds = guardians.map((g) => g.toState().childId);
      linkedChildren = await this.childRepo.findByIdsCrossTenant(childIds);
    }

    const allowedActions = computeAllowedActions(role, guardians);

    // 6) Stamp last_scanned_at — best-effort, fire-and-forget would also be
    // acceptable but await keeps the integration test deterministic.
    await this.qrRepo.updateLastScannedAt(state.id, now);

    // TODO(B-future): use staffMembers for per-role action authorization
    // (e.g. mentor-only gate_entry).
    void staffMembers;

    return { user, role, linkedChildren, allowedActions };
  }

  // ── revokeAllByUser ─────────────────────────────────────────────────────

  async revokeAllByUser(
    adminUserId: string,
    targetUserId: string,
  ): Promise<RevokeAllResult> {
    const now = this.clock.now();
    const { revokedHashes } = await this.qrRepo.revokeAllByUser(
      targetUserId,
      'identity',
      now,
    );
    // Clear the user-keyed reuse cache so the next `GET /users/me/qr`
    // mints fresh instead of returning the just-revoked plaintext. The
    // plaintext-keyed `qr:token:{plaintext}` cannot be cleared here
    // (admin has only the hash); it stays correct because `scan`'s
    // DB-recheck still surfaces `qr_token_revoked` (410). Always clear
    // (even when revokedHashes is empty) so we don't end up with a stale
    // user-key pointing at a row we believe absent.
    await this.cache.clearUserActiveToken(targetUserId);
    if (revokedHashes.length > 0) {
      this.logger.log(
        `qr.revoke_all admin=${adminUserId} user=${targetUserId} count=${revokedHashes.length}`,
      );
    }
    // TODO(B22): write a row to audit_log when that table exists.
    return { revokedCount: revokedHashes.length };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Determine the effective role label and supporting guardian/staff rows for
   * a scanned user. Mirrors the auth-side `assembleRoles` heuristics in the
   * narrow form needed for QR scan:
   *   - any active staff entry → `role = first staff entry's role`
   *   - else any approved-active guardian → `role = 'parent'`
   *   - else → `role = 'parent'` (no actionable children, but still a valid
   *     identity — staff app shows the name + empty actions list)
   *
   * The auth role-assembly is NOT used here because it returns multi-role
   * branches; for QR we collapse to a single label suitable for the staff
   * app's UI.
   *
   * `scanningKgId` is the caller's `kindergarten_id` from the JWT (or null
   * for super_admin). When non-null, the parent guardian list is scoped to
   * that kg — staff in kg-A scanning a parent who has children in both kg-A
   * and kg-B sees only the kg-A children. The `findApprovedActiveBy` repo
   * method already accepts an optional kg-id and applies the scope inside
   * the bypass-RLS lookup, so we delegate directly.
   */
  private async resolveRoleContext(
    userId: string,
    scanningKgId: string | null,
  ): Promise<{
    role: string;
    staffMembers: StaffMember[];
    guardians: ChildGuardian[];
  }> {
    const staffMembers =
      await this.staffMemberRepo.findAllActiveByUserId(userId);
    if (staffMembers.length > 0) {
      // Cross-tenant guardian read is unnecessary — staff can also be a
      // parent in some tenant, but the staff app does not need both lists
      // simultaneously. Skip guardian load to keep the scan response lean.
      return { role: staffMembers[0].role, staffMembers, guardians: [] };
    }
    // scanningKgId === null when super_admin scans (no kg claim) — fall
    // back to cross-tenant in that narrow case; the staff-only gate at the
    // controller already prevents this in production.
    const guardians =
      await this.childGuardianRepo.findApprovedActiveByUserIdCrossTenant(
        userId,
        scanningKgId ?? undefined,
      );
    return { role: 'parent', staffMembers, guardians };
  }
}

/**
 * Per-role allowed action computation. Pure — separated from the service
 * class for unit-testability and to keep the role policy in one obvious
 * place.
 */
export function computeAllowedActions(
  role: string,
  guardians: ChildGuardian[],
): string[] {
  if (role === 'parent') {
    const hasPickupRight = guardians.some((g) => {
      const s = g.toState();
      return (
        s.status === 'approved' && s.revokedAt === null && s.canPickup === true
      );
    });
    return hasPickupRight ? ['check_in', 'check_out'] : [];
  }
  if (
    role === 'mentor' ||
    role === 'specialist' ||
    role === 'reception' ||
    role === 'admin'
  ) {
    return ['gate_entry'];
  }
  // super_admin / support / unknown → no actions.
  return [];
}

function sha256Hex(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
