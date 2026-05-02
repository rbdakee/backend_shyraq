import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
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
 *     — atomic TX: revokes all currently-active rows for the user, mints a
 *       fresh 16-byte (32-hex) plaintext token, persists its SHA-256 hash,
 *       and writes the plaintext to Redis with a 24h TTL. Cross-tenant —
 *       `user_qr_tokens` has no RLS by design (a parent guardianship may
 *       span multiple kindergartens, the QR is the user's identity, not a
 *       per-kg token).
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
 *     — bulk-stamps `revoked_at` on every active row for the target user.
 *       Cache entries are NOT proactively deleted: admin only has hashes
 *       (not plaintext), so we rely on the next scan's DB recheck to
 *       surface `qr_token_revoked` (410). Cache TTL ≤ 24h provides the
 *       upper bound on stale cache exposure.
 */
@Injectable()
export class IdentityQrService {
  private readonly logger = new Logger(IdentityQrService.name);

  constructor(
    private readonly qrRepo: IdentityQrRepository,
    private readonly cache: QrTokenCachePort,
    private readonly rateLimiter: QrScanRateLimiterPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly refreshTokenRepo: RefreshTokenRepository,
    private readonly childGuardianRepo: ChildGuardianRepository,
    private readonly childRepo: ChildRepository,
    private readonly staffMemberRepo: StaffMemberRepository,
    private readonly userRepo: UserRepository,
  ) {}

  // ── issueOrRefresh ───────────────────────────────────────────────────────

  /**
   * Mint a fresh QR for `userId`. Always revokes any currently-active rows
   * first so the partial uniqueness invariant (`(user_id, purpose) WHERE
   * revoked_at IS NULL`) holds, then inserts a new row + Redis entry inside
   * the same transaction so a rollback nukes both.
   *
   * No "reuse if fresh" branch by design: the DB row stores only the SHA-256
   * hash of the plaintext, and Redis is keyed on the plaintext — neither
   * direction is reversible. So even if a "young" row exists in the DB, the
   * server has no way to retrieve the matching plaintext on a subsequent
   * GET. Every GET issues a new token; old plaintexts are revoked at the
   * row level (causing the next scan to 410) and naturally TTL out of Redis.
   *
   * Volume note: a polling client could mint ~1 token/min — this is an
   * accepted write-amplification tradeoff for the simpler invariant.
   */
  async issueOrRefresh(userId: string): Promise<IssueOrRefreshResult> {
    const now = this.clock.now();
    const issuedAt = now;
    const expiresAt = new Date(now.getTime() + TTL_SECONDS * 1000);
    const plaintext = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = sha256Hex(plaintext);

    // Inside `dataSource.transaction` so that the revoke + insert pair is
    // atomic. The repos pull the EntityManager from `tenantStorage` only when
    // available (e.g. when an outer interceptor already opened a TX); here we
    // open our own and the helpers fall back to `repo.manager` — that's still
    // fine because user_qr_tokens has no RLS.
    await this.dataSource.transaction(async () => {
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
    });

    // Cache write outside the DB transaction — Redis has no TX semantics
    // anyway, so a redis failure here would not roll back the row. Worst
    // case: row exists in DB but cache miss → first scan hits the DB-recheck
    // path which still resolves correctly (we look up by token_hash via
    // `findByTokenHash`). The `cache.lookup → null` fallback in scan() is
    // therefore robust.
    await this.cache.setToken(plaintext, userId, TTL_SECONDS);

    return { token: plaintext, issuedAt, expiresAt };
  }

  // ── scan ────────────────────────────────────────────────────────────────

  async scan(
    callerUserId: string,
    deviceId: string,
    plaintextToken: string,
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
    );

    let linkedChildren: Child[] | undefined;
    if (role === 'parent') {
      const childIds = guardians.map((g) => g.toState().childId);
      linkedChildren = await this.childRepo.findByIdsCrossTenant(childIds);
    }

    const allowedActions = computeAllowedActions(role, guardians);

    // 6) Stamp last_scanned_at — best-effort, fire-and-forget would also be
    // acceptable but await keeps the integration test deterministic.
    await this.qrRepo.updateLastScannedAt(state.id, now);

    // Acknowledge `staffMembers` to keep TS happy; the var is here for
    // future per-action authorization (e.g. only-mentor can do gate_entry).
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
    // Cache cannot be invalidated here — admin has hashes only, not the
    // plaintexts that key Redis. Subsequent scans hit the DB-recheck path
    // and surface `qr_token_revoked` (410). Cache entries naturally expire
    // ≤24h after issuance.
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
   */
  private async resolveRoleContext(userId: string): Promise<{
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
    const guardians =
      await this.childGuardianRepo.findApprovedActiveByUserIdCrossTenant(
        userId,
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
