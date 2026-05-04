import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AllConfigType } from '@/config/config.type';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { User } from '@/modules/users/domain/entities/user.entity';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import {
  AuthResult,
  RoleView,
  SuperAdminAuthResult,
  UserSummaryView,
} from './auth-result.view';
import {
  computeRefreshExpiresAt,
  generateRefreshToken,
  hashRefreshToken,
} from './refresh-token.helper';
import { OtpAttempt } from './domain/entities/otp-attempt.entity';
import { InvalidCredentialsError } from './domain/errors/invalid-credentials.error';
import { NoActiveRolesError } from './domain/errors/no-active-roles.error';
import { OtpExpiredError } from './domain/errors/otp-expired.error';
import { OtpInvalidError } from './domain/errors/otp-invalid.error';
import { OtpLockedError } from './domain/errors/otp-locked.error';
import { OtpRateLimitedError } from './domain/errors/otp-rate-limited.error';
import { RefreshInvalidError } from './domain/errors/refresh-invalid.error';
import { RoleNotAvailableError } from './domain/errors/role-not-available.error';
import { RoleSelectNotRequiredError } from './domain/errors/role-select-not-required.error';
import { SaasLoginRateLimitError } from './domain/errors/saas-login-rate-limit.error';
import { JwtTokenPort } from './jwt-token.port';
import { OtpStorePort } from './otp-store.port';
import { PasswordHasherPort } from './password-hasher.port';
import { RefreshTokenRepository } from './infrastructure/persistence/refresh-token.repository';
import { SaasRefreshTokenRepository } from './infrastructure/persistence/saas-refresh-token.repository';
import { SaasUserRepository } from './infrastructure/persistence/saas-user.repository';
import { SmsPort } from './sms.port';
import { TokenBlocklistPort } from './token-blocklist.port';
import { NotificationPort } from '@/common/notifications/notification.port';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';

const OTP_LOCKED_TTL_SEC = 900;
const OTP_RESEND_AFTER_SEC = 60;

export interface RequestOtpResult {
  resendAfterSec: number;
}

export interface VerifyOtpInput {
  phone: string;
  code: string;
  deviceId?: string;
  ipAddress?: string;
}

export interface RefreshInput {
  rawRefreshToken: string;
  oldAccessJti?: string;
  oldAccessExpUnix?: number;
  deviceId?: string;
  ipAddress?: string;
}

export interface LogoutInput {
  userId: string;
  rawRefreshToken?: string;
  accessJti?: string;
  accessExpUnix?: number;
}

export interface SelectRoleInput {
  userId: string;
  kindergartenId: string;
  role?: string;
  /** Must be true — only JWTs issued with pending_role_select:true may call this. */
  pendingRoleSelect: boolean;
  oldAccessJti?: string;
  oldAccessExpUnix?: number;
  deviceId?: string;
  ipAddress?: string;
}

export interface SuperAdminLoginInput {
  email: string;
  password: string;
  deviceId?: string;
  ipAddress?: string;
}

export interface SuperAdminRefreshInput {
  rawRefreshToken: string;
  oldAccessJti?: string;
  oldAccessExpUnix?: number;
  deviceId?: string;
  ipAddress?: string;
}

export interface SuperAdminLogoutInput {
  saasUserId: string;
  rawRefreshToken?: string;
  accessJti?: string;
  accessExpUnix?: number;
}

/**
 * AuthService — orchestrates OTP, JWT issuance/rotation, and SaaS-admin
 * password auth. Pure application layer: takes domain repositories + ports
 * via DI, never touches TypeORM/Redis directly. Each public method maps 1:1
 * to a controller endpoint.
 *
 * Role assembly queries StaffMemberRepository for all active staff entries
 * across kindergartens. Users with no staff rows get the implicit `parent`
 * role; staff users receive per-kg roles. `selectRole` validates the
 * requested (userId, kindergartenId, role) triple against the same table
 * and issues a scoped access token on success.
 */
const KG_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private testPhones: ReadonlySet<string> = new Set();

  constructor(
    private readonly users: UserRepository,
    private readonly saasUsers: SaasUserRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly saasRefreshTokens: SaasRefreshTokenRepository,
    private readonly otpStore: OtpStorePort,
    private readonly sms: SmsPort,
    private readonly jwt: JwtTokenPort,
    private readonly passwords: PasswordHasherPort,
    private readonly blocklist: TokenBlocklistPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly staff: StaffMemberRepository,
    private readonly guardians: ChildGuardianRepository,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(NotificationPort)
    private readonly notifications: NotificationPort,
  ) {}

  onModuleInit(): void {
    const csv =
      this.configService.get('auth.otpTestPhones', { infer: true }) ?? '';
    const parsed = new Set(
      csv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

    if (process.env.NODE_ENV === 'production') {
      if (parsed.size > 0) {
        this.logger.warn(
          `OTP test backdoor IGNORED (NODE_ENV=production); refusing to honour OTP_TEST_PHONES`,
        );
      }
      // Treat as empty set in production — backdoor is never active.
      this.testPhones = new Set();
      return;
    }

    this.testPhones = parsed;
    if (parsed.size > 0) {
      this.logger.warn(
        `OTP test backdoor active for ${parsed.size} phone(s) (NODE_ENV=${process.env.NODE_ENV ?? 'unknown'})`,
      );
    }
  }

  // ------------------------------------------------------------------ OTP

  async requestOtp(phone: string): Promise<RequestOtpResult> {
    if (await this.otpStore.isLocked(phone)) {
      throw new OtpLockedError();
    }
    const limit = this.configService.getOrThrow(
      'auth.rateLimitOtpRequestLimit',
      { infer: true },
    );
    const window = this.configService.getOrThrow(
      'auth.rateLimitOtpRequestWindowSec',
      { infer: true },
    );
    const state = await this.otpStore.checkRateLimit(phone, limit, window);
    if (state === 'exceeded') {
      throw new OtpRateLimitedError();
    }

    const ttlSec = this.configService.getOrThrow('auth.otpTtlSeconds', {
      infer: true,
    });
    const code = this.isTestPhone(phone)
      ? this.testCode()
      : this.generateCode();
    await this.otpStore.storeCode(phone, code, ttlSec);

    if (!this.isTestPhone(phone)) {
      await this.sms.send(phone, `Shyraq: ${code}`);
    }
    return { resendAfterSec: OTP_RESEND_AFTER_SEC };
  }

  async verifyOtp(input: VerifyOtpInput): Promise<AuthResult> {
    await this.consumeOtp(input.phone, input.code);

    const user = await this.users.upsertByPhone(input.phone);
    await this.autoApprovePendingPrimaries(user.id, this.clock.now());
    return this.issueTokensForUser(user, {
      deviceId: input.deviceId ?? null,
      ipAddress: input.ipAddress ?? null,
    });
  }

  // ----------------------------------------------------------- Refresh / Logout

  async refreshToken(input: RefreshInput): Promise<AuthResult> {
    const now = this.clock.now();
    const newRaw = generateRefreshToken();
    const newHash = hashRefreshToken(newRaw);
    const ttlDays = this.configService.getOrThrow('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const newExpiresAt = computeRefreshExpiresAt(now, ttlDays);

    const rotated = await this.refreshTokens.rotate({
      tokenHash: hashRefreshToken(input.rawRefreshToken),
      now,
      newTokenHash: newHash,
      newExpiresAt,
      deviceIdOverride: input.deviceId ?? null,
      ipAddressOverride: input.ipAddress ?? null,
    });
    if (!rotated) {
      throw new RefreshInvalidError();
    }
    if (input.oldAccessJti && typeof input.oldAccessExpUnix === 'number') {
      await this.blocklist.blocklist(
        input.oldAccessJti,
        input.oldAccessExpUnix,
      );
    }

    const user = await this.users.findById(rotated.userId);
    if (!user) {
      // Race: refresh row exists but user was deleted. Treat as invalid.
      throw new RefreshInvalidError();
    }

    const { roles, kindergartens } = await this.assembleRoles(user);
    if (roles.length === 0) {
      throw new NoActiveRolesError();
    }

    // Bind the rotated access token to the kg recorded on the ORIGINAL
    // refresh-token row, never to an arbitrary roles[0]. A user with roles
    // across multiple tenants (parent in kg-B + staff in kg-A) must remain
    // scoped to whichever tenant the prior session belonged to — otherwise a
    // refresh would silently jump tenants. If the user has lost their role
    // in `rotated.kindergartenId` since the refresh row was issued
    // (staff_member deactivated, guardian revoked), there is no role to
    // re-issue against → NoActiveRolesError. The response still surfaces
    // every current (role, kg) so the client can offer role-switch UI.
    const rotatedKgId = rotated.kindergartenId;
    const matched = this.pickRoleForRotation(roles, rotatedKgId);
    if (!matched) {
      throw new NoActiveRolesError();
    }
    const access = await this.jwt.issueAccessToken({
      sub: user.id,
      role: matched.role,
      kindergarten_id: matched.kindergartenId,
    });
    return {
      accessToken: access.token,
      refreshToken: newRaw,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      pendingRoleSelect: false,
      roles,
      kindergartens,
      user: this.toUserSummary(user),
    };
  }

  async logout(input: LogoutInput): Promise<void> {
    const now = this.clock.now();
    if (input.rawRefreshToken) {
      await this.refreshTokens.revokeByHash(
        hashRefreshToken(input.rawRefreshToken),
        now,
      );
    } else {
      await this.refreshTokens.revokeAllByUserId(input.userId, now);
    }
    if (input.accessJti && typeof input.accessExpUnix === 'number') {
      await this.blocklist.blocklist(input.accessJti, input.accessExpUnix);
    }
  }

  // ---------------------------------------------------------------- Role-select

  async selectRole(input: SelectRoleInput): Promise<AuthResult> {
    if (!input.pendingRoleSelect) {
      throw new RoleSelectNotRequiredError();
    }
    const staffEntries = await this.staff.findAllActiveByUserId(input.userId);
    const match = staffEntries.find(
      (s) =>
        s.kindergartenId === input.kindergartenId &&
        (input.role === undefined || s.role === input.role),
    );
    let selectedRole: string | null = null;
    let selectedKindergartenId: string | null = null;
    if (match) {
      selectedRole = match.role;
      selectedKindergartenId = match.kindergartenId;
    } else {
      const guardianKindergartenIds =
        await this.guardians.listApprovedKindergartenIdsByUserId(input.userId);
      const hasParentRole =
        (input.role === undefined || input.role === 'parent') &&
        guardianKindergartenIds.includes(input.kindergartenId);
      if (hasParentRole) {
        selectedRole = 'parent';
        selectedKindergartenId = input.kindergartenId;
      } else {
        throw new RoleNotAvailableError();
      }
    }

    if (input.oldAccessJti && typeof input.oldAccessExpUnix === 'number') {
      await this.blocklist.blocklist(
        input.oldAccessJti,
        input.oldAccessExpUnix,
      );
    }

    const access = await this.jwt.issueAccessToken({
      sub: input.userId,
      role: selectedRole,
      kindergarten_id: selectedKindergartenId,
    });
    const raw = generateRefreshToken();
    const ttlDays = this.configService.getOrThrow('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const expiresAt = computeRefreshExpiresAt(this.clock.now(), ttlDays);
    // selectRole runs without KindergartenScopeGuard, so the ambient
    // TenantContextInterceptor TX has no GUC set (kgId=null, bypass=false).
    // RefreshTokenRelationalRepository.create would pick up that ambient
    // manager and fail the RLS WITH CHECK. Open a fresh TX with bypass_rls
    // and override tenantStorage so create() uses it.
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      await tenantStorage.run(
        { kgId: selectedKindergartenId, bypass: true, entityManager: manager },
        () =>
          this.refreshTokens.create({
            userId: input.userId,
            kindergartenId: selectedKindergartenId,
            tokenHash: hashRefreshToken(raw),
            deviceId: input.deviceId ?? null,
            ipAddress: input.ipAddress ?? null,
            expiresAt,
          }),
      );
    });

    const user = await this.users.findById(input.userId);
    if (!user) {
      throw new RefreshInvalidError();
    }
    return {
      accessToken: access.token,
      refreshToken: raw,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      pendingRoleSelect: false,
      roles: [
        {
          role: selectedRole,
          kindergartenId: selectedKindergartenId,
          groupId: null,
        },
      ],
      kindergartens: [{ id: selectedKindergartenId, name: '', slug: '' }],
      user: this.toUserSummary(user),
    };
  }

  // --------------------------------------------------------------- SuperAdmin

  async superAdminLogin(
    input: SuperAdminLoginInput,
  ): Promise<SuperAdminAuthResult> {
    // Rate-limit per email (lowercased + trimmed) — 10 attempts per hour.
    const normalizedEmail = input.email.toLowerCase().trim();
    const rlLimit = this.configService.getOrThrow(
      'auth.rateLimitSuperAdminLoginLimit',
      { infer: true },
    );
    const rlWindow = this.configService.getOrThrow(
      'auth.rateLimitSuperAdminLoginWindowSec',
      { infer: true },
    );
    const rlState = await this.otpStore.checkRateLimitGeneric(
      `rate:saas:login:${normalizedEmail}`,
      rlLimit,
      rlWindow,
    );
    if (rlState === 'exceeded') {
      throw new SaasLoginRateLimitError();
    }

    const user = await this.saasUsers.findByEmail(normalizedEmail);
    const valid =
      user !== null &&
      user.isActive &&
      (await this.passwords.compare(input.password, user.passwordHash));
    if (!user || !valid) {
      throw new InvalidCredentialsError();
    }

    await this.saasUsers.updateLastLogin(user.id, this.clock.now());
    const access = await this.jwt.issueAccessToken({
      sub: user.id,
      role: user.role,
    });
    const raw = generateRefreshToken();
    const newHash = hashRefreshToken(raw);
    const ttlDays = this.configService.getOrThrow('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const expiresAt = computeRefreshExpiresAt(this.clock.now(), ttlDays);
    await this.saasRefreshTokens.create({
      saasUserId: user.id,
      tokenHash: newHash,
      deviceId: input.deviceId ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
    });

    return {
      accessToken: access.token,
      refreshToken: raw,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      pendingRoleSelect: false,
      roles: [{ role: user.role, kindergartenId: null, groupId: null }],
    };
  }

  async superAdminRefresh(
    input: SuperAdminRefreshInput,
  ): Promise<SuperAdminAuthResult> {
    const now = this.clock.now();
    const newRaw = generateRefreshToken();
    const newHash = hashRefreshToken(newRaw);
    const ttlDays = this.configService.getOrThrow('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const newExpiresAt = computeRefreshExpiresAt(now, ttlDays);

    const rotated = await this.saasRefreshTokens.rotate({
      tokenHash: hashRefreshToken(input.rawRefreshToken),
      now,
      newTokenHash: newHash,
      newExpiresAt,
      deviceIdOverride: input.deviceId ?? null,
      ipAddressOverride: input.ipAddress ?? null,
    });
    if (!rotated) throw new RefreshInvalidError();
    if (input.oldAccessJti && typeof input.oldAccessExpUnix === 'number') {
      await this.blocklist.blocklist(
        input.oldAccessJti,
        input.oldAccessExpUnix,
      );
    }

    const user = await this.saasUsers.findById(rotated.saasUserId);
    if (!user || !user.isActive) {
      throw new RefreshInvalidError();
    }

    const access = await this.jwt.issueAccessToken({
      sub: user.id,
      role: user.role,
    });
    return {
      accessToken: access.token,
      refreshToken: newRaw,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      pendingRoleSelect: false,
      roles: [{ role: user.role, kindergartenId: null, groupId: null }],
    };
  }

  async superAdminLogout(input: SuperAdminLogoutInput): Promise<void> {
    const now = this.clock.now();
    if (input.rawRefreshToken) {
      await this.saasRefreshTokens.revokeByHash(
        hashRefreshToken(input.rawRefreshToken),
        now,
      );
    } else {
      await this.saasRefreshTokens.revokeAllBySaasUserId(input.saasUserId, now);
    }
    if (input.accessJti && typeof input.accessExpUnix === 'number') {
      await this.blocklist.blocklist(input.accessJti, input.accessExpUnix);
    }
  }

  // ---------------------------------------------------------------- internals

  private isTestPhone(phone: string): boolean {
    return this.testPhones.has(phone);
  }

  private testCode(): string {
    return (
      this.configService.get('auth.otpTestCode', { infer: true }) ?? '000000'
    );
  }

  private generateCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  private async consumeOtp(phone: string, submitted: string): Promise<void> {
    if (await this.otpStore.isLocked(phone)) {
      throw new OtpLockedError();
    }
    const stored = await this.otpStore.readCode(phone);
    if (!stored) {
      throw new OtpExpiredError();
    }
    const attempt = OtpAttempt.hydrate({
      phone,
      code: stored.code,
      attempts: stored.attempts,
    });
    if (attempt.matches(submitted)) {
      await this.otpStore.clearCode(phone);
      return;
    }
    const attempts = await this.otpStore.incrementAttempts(phone);
    if (attempts >= 3) {
      await this.otpStore.lockPhone(phone, OTP_LOCKED_TTL_SEC);
      await this.otpStore.clearCode(phone);
      throw new OtpLockedError();
    }
    throw new OtpInvalidError();
  }

  private async issueTokensForUser(
    user: User,
    meta: { deviceId: string | null; ipAddress: string | null },
  ): Promise<AuthResult> {
    const { roles, kindergartens } = await this.assembleRoles(user);
    if (roles.length === 0) {
      throw new NoActiveRolesError();
    }

    // Multi-role branch — pending selection. Reserved for P3+; with the
    // single implicit `parent` role today this branch never fires, but the
    // shape stays so e2e/swagger documents the eventual response.
    if (roles.length >= 2) {
      const access = await this.jwt.issueAccessToken({
        sub: user.id,
        role: 'staff_multi_role',
        pending_role_select: true,
      });
      return {
        accessToken: access.token,
        refreshToken: null,
        tokenType: 'Bearer',
        expiresIn: access.expiresIn,
        pendingRoleSelect: true,
        roles,
        kindergartens,
        user: this.toUserSummary(user),
      };
    }

    const role = roles[0].role;
    const kgId = roles[0].kindergartenId;
    const access = await this.jwt.issueAccessToken({
      sub: user.id,
      role,
      kindergarten_id: kgId,
    });
    const raw = generateRefreshToken();
    const ttlDays = this.configService.getOrThrow('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const expiresAt = computeRefreshExpiresAt(this.clock.now(), ttlDays);
    await this.refreshTokens.create({
      userId: user.id,
      kindergartenId: kgId,
      tokenHash: hashRefreshToken(raw),
      deviceId: meta.deviceId,
      ipAddress: meta.ipAddress,
      expiresAt,
    });
    return {
      accessToken: access.token,
      refreshToken: raw,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      pendingRoleSelect: false,
      roles,
      kindergartens,
      user: this.toUserSummary(user),
    };
  }

  /**
   * Returns the role+kg list visible to a given user. Queries StaffMemberRepository
   * for all active staff entries across kindergartens. Users with no staff entries
   * get the implicit `parent` role. Staff users get per-kg roles from the DB.
   */
  private async assembleRoles(user: User): Promise<{
    roles: RoleView[];
    kindergartens: { id: string; name: string; slug: string }[];
  }> {
    const [staffEntries, guardianKindergartenIds] = await Promise.all([
      this.staff.findAllActiveByUserId(user.id),
      this.guardians.listApprovedKindergartenIdsByUserId(user.id),
    ]);

    const roles: RoleView[] = staffEntries.map((s) => ({
      role: s.role,
      kindergartenId: s.kindergartenId,
      groupId: null,
    }));

    // Append parent rows for kgs where the user has approved guardian links
    // but no staff_member row. A user who is staff in kg-A and parent in kg-B
    // gets BOTH `{role:'admin', kg:'kg-A'}` and `{role:'parent', kg:'kg-B'}`.
    // Same-kg dedup: prefer staff over parent (don't surface a redundant
    // parent row when the user already has a staff role in that kg).
    const staffKgIds = new Set(staffEntries.map((s) => s.kindergartenId));
    for (const kgId of guardianKindergartenIds) {
      if (!staffKgIds.has(kgId)) {
        roles.push({ role: 'parent', kindergartenId: kgId, groupId: null });
      }
    }

    // Empty case: no staff, no guardian — surface a parent row with null kg
    // so the caller can still issue a token (legacy parent shape).
    if (roles.length === 0) {
      return {
        roles: [{ role: 'parent', kindergartenId: null, groupId: null }],
        kindergartens: [],
      };
    }

    // Deduplicate kindergarten ids across staff + guardian sources.
    const seen = new Set<string>();
    const kindergartens: { id: string; name: string; slug: string }[] = [];
    for (const r of roles) {
      if (r.kindergartenId !== null && !seen.has(r.kindergartenId)) {
        seen.add(r.kindergartenId);
        kindergartens.push({ id: r.kindergartenId, name: '', slug: '' });
      }
    }

    return { roles, kindergartens };
  }

  /**
   * Pick the role to bind to a rotated access token.
   *
   * Source of truth is `rotatedKgId` — the kg recorded on the original
   * refresh-token row, NOT the user's current full role list. This prevents
   * a refresh from silently jumping tenants when a user has roles in
   * multiple kindergartens (e.g. parent in kg-B + staff in kg-A).
   *
   * Selection rules:
   *   - `rotatedKgId === null` → first try the legacy null-kg row (parent
   *     who still has no guardian links). If none exists, fall through to
   *     the first parent-with-kg role. This supports the B6 onboarding flow:
   *     parent OTP-verifies before any guardian link → null-kg refresh
   *     issued; later they get linked + approved → on the next refresh the
   *     session "upgrades" into the kg they were just admitted to. The
   *     upgrade is bounded to `parent` roles — we never let a null-kg
   *     refresh escalate into a staff role discovered after the fact.
   *   - `rotatedKgId !== null` → match a role with the same kindergarten.
   *     If both staff and parent exist for that kg (rare but possible
   *     when admins are also parents at their own kg), prefer staff for a
   *     deterministic choice; staff carries the higher privilege.
   *   - No match → return null; caller throws NoActiveRolesError.
   */
  private pickRoleForRotation(
    roles: RoleView[],
    rotatedKgId: string | null,
  ): RoleView | null {
    if (rotatedKgId === null) {
      const nullKg = roles.find((r) => r.kindergartenId === null);
      if (nullKg) return nullKg;
      return roles.find((r) => r.role === 'parent') ?? null;
    }
    const matching = roles.filter((r) => r.kindergartenId === rotatedKgId);
    if (matching.length === 0) return null;
    const staff = matching.find((r) => r.role !== 'parent');
    return staff ?? matching[0];
  }

  /**
   * Auto-approve hook for the OTP-verify flow. Pending-primary rows are
   * pre-seeded by the enrollment `card_created` transition (admin invites the
   * parent by phone before the parent has logged in). Once the parent passes
   * OTP for that phone, ownership is proven — flip every such row across
   * tenants to `approved` so the parent app immediately sees their child(ren).
   *
   * Each row sits in its own tenant, so we open a tenant-scoped TX per row to
   * satisfy the `kindergarten_id = current_setting('app.kindergarten_id')`
   * RLS policy on UPDATE. Cross-tenant SELECT lives inside the repo (which
   * sets `app.bypass_rls`).
   */
  private async autoApprovePendingPrimaries(
    userId: string,
    now: Date,
  ): Promise<void> {
    const pending =
      await this.guardians.findPendingPrimaryByUserIdCrossTenant(userId);
    if (pending.length === 0) return;
    for (const guardian of pending) {
      const kgId = guardian.kindergartenId as string;
      if (!KG_UUID_RE.test(kgId)) {
        // Defensive: a malformed kg id from DB shouldn't bring auth down —
        // skip and log so an operator can investigate.
        this.logger.warn(
          `autoApprovePendingPrimaries: skipping guardian=${guardian.id} with malformed kindergarten_id=${kgId}`,
        );
        continue;
      }
      await this.dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        await tenantStorage.run(
          { kgId, bypass: false, entityManager: manager },
          async () => {
            guardian.autoApproveAsPrimary(now);
            await this.guardians.update(guardian);
            await this.notifications.notifyGuardianApproved({
              kindergartenId: kgId,
              childId: guardian.childId,
              guardianUserId: guardian.userId,
              approvedBy: guardian.userId,
              hasApprovalRights: guardian.hasApprovalRights,
            });
          },
        );
      });
    }
  }

  private toUserSummary(user: User): UserSummaryView {
    const s = user.toState();
    return {
      id: s.id,
      phone: s.phone,
      fullName: s.fullName,
      avatarUrl: s.avatarUrl,
      iin: s.iin,
      dateOfBirth: s.dateOfBirth,
      locale: s.locale,
    };
  }
}
