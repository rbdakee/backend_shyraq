import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { AllConfigType } from '@/config/config.type';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
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
import { NoRoleForAppError } from './domain/errors/no-role-for-app.error';
import { NotInvitedError } from './domain/errors/not-invited.error';
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
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';

const OTP_LOCKED_TTL_SEC = 900;
const OTP_RESEND_AFTER_SEC = 60;

/** Which client app the login targets — drives the audience filter. */
export type AuthApp = 'parent' | 'staff' | 'admin';

/** Roles allowed per app (docs/endpoints.md §0.1 audience table). */
const APP_ALLOWED_ROLES: Record<AuthApp, ReadonlySet<string>> = {
  parent: new Set(['parent']),
  staff: new Set(['mentor', 'specialist', 'reception']),
  admin: new Set(['admin']),
};

/** Map a staff/admin role to the app audience it belongs to. */
function audienceForRole(role: string): AuthApp {
  return role === 'admin' ? 'admin' : 'staff';
}

export interface RequestOtpResult {
  resendAfterSec: number;
  /** Whether a users row already existed for this phone. */
  registered: boolean;
}

export interface VerifyOtpInput {
  phone: string;
  code: string;
  app: AuthApp;
  kindergartenId?: string;
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
    @Inject(TransactionRunnerPort)
    private readonly tx: TransactionRunnerPort,
    @Inject(NotificationPort)
    private readonly notifications: NotificationPort,
    private readonly groups: GroupRepository,
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

  async requestOtp(phone: string, app: AuthApp): Promise<RequestOtpResult> {
    // Closed-app existence check (staff/admin) runs BEFORE any OTP is
    // generated/sent: staff & admins are only ever created by invite, so an
    // unknown phone must get 404 not_invited with no SMS leaked. Parent app is
    // open-registration and never rejected here.
    let registered = false;
    if (app === 'staff' || app === 'admin') {
      const user = await this.users.findByPhone(phone);
      if (!user) {
        throw new NotInvitedError();
      }
      registered = true;
      const allowed = APP_ALLOWED_ROLES[app];
      const staffEntries = await this.staff.findAllActiveByUserId(user.id);
      const hasRole = staffEntries.some((s) => allowed.has(s.role));
      if (!hasRole) {
        throw new NotInvitedError();
      }
    } else {
      const user = await this.users.findByPhone(phone);
      registered = user !== null;
    }

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
      await this.sms.sendOtp(phone, code);
    }
    return { resendAfterSec: OTP_RESEND_AFTER_SEC, registered };
  }

  async verifyOtp(input: VerifyOtpInput): Promise<AuthResult> {
    await this.consumeOtp(input.phone, input.code);

    // Determine new-user BEFORE upsert (parent-app extra). A row created by
    // this verify ⇒ isNewUser=true; an existing row (incl. admin-seeded
    // guardian/staff) ⇒ false.
    const existing = await this.users.findByPhone(input.phone);
    const isNewUser = existing === null;

    const user = await this.users.upsertByPhone(input.phone);
    await this.autoApprovePendingPrimaries(user.id, this.clock.now());

    return this.issueTokensForUser(user, input.app, {
      deviceId: input.deviceId ?? null,
      ipAddress: input.ipAddress ?? null,
      requestedKindergartenId: input.kindergartenId ?? null,
      isNewUser,
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

    const { roles: allRoles } = await this.assembleRoles(user);

    // Audience filter on rotation (STEP 3): re-resolve roles against the
    // audience stored on the rotated row so a session never jumps apps. Legacy
    // rows have audience=NULL → treat as "no filter" (pre-app-aware behavior)
    // so existing sessions keep rotating without a forced re-login.
    const audience = rotated.audience;
    const roles =
      audience === null
        ? allRoles
        : this.filterRolesForApp(allRoles, audience as AuthApp);
    if (roles.length === 0) {
      throw new NoActiveRolesError();
    }
    const kindergartens = this.kindergartensFromRoles(roles);

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
      // Re-bake the SAME audience onto the new access token (undefined for
      // legacy null-audience rows so we don't invent an aud claim).
      aud: audience ?? undefined,
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

    // Audience the selected session belongs to. Staff/admin roles map to
    // their app (admin→admin, mentor/specialist/reception→staff); a parent
    // selection (legacy multi-kg parent path) stays on the parent audience.
    const selectedAudience: AuthApp =
      selectedRole === 'parent' || selectedRole === null
        ? 'parent'
        : audienceForRole(selectedRole);

    const access = await this.jwt.issueAccessToken({
      sub: input.userId,
      role: selectedRole,
      kindergarten_id: selectedKindergartenId,
      aud: selectedAudience,
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
    await this.tx.run(async (manager) => {
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
            audience: selectedAudience,
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
          // Non-null only for the staff `specialist` role; the parent-select
          // branch leaves `match` undefined → null.
          specialistType: match?.specialistType ?? null,
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
      roles: [
        {
          role: user.role,
          kindergartenId: null,
          groupId: null,
          specialistType: null,
        },
      ],
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
      roles: [
        {
          role: user.role,
          kindergartenId: null,
          groupId: null,
          specialistType: null,
        },
      ],
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
    app: AuthApp,
    meta: {
      deviceId: string | null;
      ipAddress: string | null;
      requestedKindergartenId: string | null;
      isNewUser: boolean;
    },
  ): Promise<AuthResult> {
    const { roles: allRoles } = await this.assembleRoles(user);

    // Audience filter (STEP 4): keep only roles allowed for the requested app
    // BEFORE the role resolve. Closes cross-app escalation — a parent phone
    // that also holds an admin role in some kg can never get an admin-scoped
    // token out of the Parent App and vice-versa. Parent App is
    // open-registration: see `filterRolesForApp`.
    const roles = this.filterRolesForApp(allRoles, app);
    if (roles.length === 0) {
      throw new NoRoleForAppError();
    }
    const kindergartens = this.kindergartensFromRoles(roles);

    // Parent-app extras — only computed/emitted when app=parent.
    const parentExtras =
      app === 'parent'
        ? await this.buildParentExtras(user, meta.isNewUser)
        : {};

    // Resolve which (role, kg) to commit the session to.
    //   - parent app: NEVER role-selects. A guardian in 2+ kindergartens gets an
    //     UNSCOPED (kg=null) session so GET /parent/children fans out
    //     cross-tenant and the parent sees children in every kg (per-child
    //     tenant is re-resolved by ChildAccessGuard). A single-kg parent keeps
    //     the kg-scoped token. The response still lists every parent kg in
    //     `roles[]`/`kindergartens[]` for client-side child-profile switching.
    //   - staff/admin: if a kindergartenId was supplied and matches a filtered
    //     role, skip the select step; else if exactly one role, issue; else
    //     (2+ roles, no match) → pending_role_select.
    let chosen: RoleView | null = null;
    if (app === 'parent') {
      const distinctKgs = new Set(
        roles.map((r) => r.kindergartenId).filter((k) => k !== null),
      );
      chosen =
        distinctKgs.size > 1
          ? {
              role: 'parent',
              kindergartenId: null,
              groupId: null,
              specialistType: null,
            }
          : roles[0];
    } else if (meta.requestedKindergartenId) {
      chosen =
        roles.find((r) => r.kindergartenId === meta.requestedKindergartenId) ??
        null;
    }
    if (!chosen && roles.length === 1) {
      chosen = roles[0];
    }

    if (!chosen) {
      // Multi-kg staff/admin with no kg match → pending role select. No refresh
      // issued; client must call /auth/role/select. Audience still travels on
      // the temporary access token's `aud` claim.
      const access = await this.jwt.issueAccessToken({
        sub: user.id,
        role: 'staff_multi_role',
        pending_role_select: true,
        aud: app,
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
        ...parentExtras,
      };
    }

    const access = await this.jwt.issueAccessToken({
      sub: user.id,
      role: chosen.role,
      kindergarten_id: chosen.kindergartenId,
      aud: app,
    });
    const raw = generateRefreshToken();
    const ttlDays = this.configService.getOrThrow('auth.refreshTokenTtlDays', {
      infer: true,
    });
    const expiresAt = computeRefreshExpiresAt(this.clock.now(), ttlDays);
    await this.refreshTokens.create({
      userId: user.id,
      kindergartenId: chosen.kindergartenId,
      tokenHash: hashRefreshToken(raw),
      deviceId: meta.deviceId,
      ipAddress: meta.ipAddress,
      expiresAt,
      audience: app,
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
      ...parentExtras,
    };
  }

  /**
   * Build the parent-app-only response extras (isNewUser, profileComplete,
   * parentContext). Returns partial AuthResult fields spread by the caller.
   */
  private async buildParentExtras(
    user: User,
    isNewUser: boolean,
  ): Promise<Partial<AuthResult>> {
    const s = user.toState();
    // profileComplete: full_name set & not equal to the phone (new users get
    // full_name = phone), date_of_birth present, iin present.
    const profileComplete =
      s.fullName.length > 0 &&
      s.fullName !== s.phone &&
      s.dateOfBirth !== null &&
      s.iin !== null;

    const [approvedLinks, pending] = await Promise.all([
      this.guardians.findApprovedActiveByUserIdCrossTenant(user.id),
      this.guardians.findPendingByApplicantUserId(user.id),
    ]);
    const distinctChildIds = new Set(approvedLinks.map((g) => g.childId));

    return {
      isNewUser,
      profileComplete,
      parentContext: {
        approvedChildrenCount: distinctChildIds.size,
        pendingRequestsCount: pending.length,
      },
    };
  }

  /** Dedupe kindergartens (id only) from a role list — empty for null-kg rows. */
  private kindergartensFromRoles(
    roles: RoleView[],
  ): { id: string; name: string; slug: string }[] {
    const seen = new Set<string>();
    const out: { id: string; name: string; slug: string }[] = [];
    for (const r of roles) {
      if (r.kindergartenId !== null && !seen.has(r.kindergartenId)) {
        seen.add(r.kindergartenId);
        out.push({ id: r.kindergartenId, name: '', slug: '' });
      }
    }
    return out;
  }

  /**
   * Apply the per-app audience filter to a user's assembled roles.
   *
   * Staff/Admin apps are strict: only roles in `APP_ALLOWED_ROLES[app]` pass,
   * and an empty result is a genuine "no role for this app" (closes cross-app
   * escalation — a parent phone can never get a staff/admin token, and vice
   * versa).
   *
   * Parent App is open-registration: ANY phone may hold a parent session, even
   * one that is also staff/admin or has no guardian link yet. When the filter
   * leaves no `parent` role we synthesize an unscoped `{role:'parent', kg:null}`
   * row instead of failing, so a freshly-registered parent can self-add a child
   * by IIN and watch its pending-approval status. Downgrading a staff/admin
   * phone to a parent-scoped token carries no privilege escalation, so this is
   * safe — the strictness that matters (parent → staff/admin) stays intact.
   */
  private filterRolesForApp(allRoles: RoleView[], app: AuthApp): RoleView[] {
    const allowed = APP_ALLOWED_ROLES[app];
    const roles = allRoles.filter((r) => allowed.has(r.role));
    if (roles.length === 0 && app === 'parent') {
      return [
        {
          role: 'parent',
          kindergartenId: null,
          groupId: null,
          specialistType: null,
        },
      ];
    }
    return roles;
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
    const [staffEntries, guardianKindergartenIds, mentorAssignments] =
      await Promise.all([
        this.staff.findAllActiveByUserId(user.id),
        this.guardians.listApprovedKindergartenIdsByUserId(user.id),
        // Cross-tenant lookup of the user's currently-active mentor
        // assignments — fetched ONCE here, then indexed by kg below so the
        // per-entry `.map` stays in-memory (no per-role DB round-trip).
        this.groups.findActiveMentorAssignmentsByUserIdCrossTenant(user.id),
      ]);

    // Index the primary active group per kindergarten for the mentor role.
    // Prefer the assignment flagged `isPrimary`; fall back to the first
    // active one in that kg when none is flagged.
    const primaryGroupByKg = new Map<string, string>();
    for (const a of mentorAssignments) {
      if (a.isPrimary || !primaryGroupByKg.has(a.kindergartenId)) {
        primaryGroupByKg.set(a.kindergartenId, a.groupId);
      }
    }

    const roles: RoleView[] = staffEntries.map((s) => ({
      role: s.role,
      kindergartenId: s.kindergartenId,
      // Only mentors carry a group; every other role stays null. Falls back
      // to null when the mentor has no active assignment in that kg.
      groupId:
        s.role === 'mentor'
          ? (primaryGroupByKg.get(s.kindergartenId) ?? null)
          : null,
      // Domain invariant: specialistType is non-null only for `specialist`
      // staff; the getter already returns null for admin/mentor/reception.
      specialistType: s.specialistType,
    }));

    // Append parent rows for kgs where the user has approved guardian links
    // but no staff_member row. A user who is staff in kg-A and parent in kg-B
    // gets BOTH `{role:'admin', kg:'kg-A'}` and `{role:'parent', kg:'kg-B'}`.
    // Same-kg dedup: prefer staff over parent (don't surface a redundant
    // parent row when the user already has a staff role in that kg).
    const staffKgIds = new Set(staffEntries.map((s) => s.kindergartenId));
    for (const kgId of guardianKindergartenIds) {
      if (!staffKgIds.has(kgId)) {
        roles.push({
          role: 'parent',
          kindergartenId: kgId,
          groupId: null,
          specialistType: null,
        });
      }
    }

    // Empty case: no staff, no guardian — surface a parent row with null kg
    // so the caller can still issue a token (legacy parent shape).
    if (roles.length === 0) {
      return {
        roles: [
          {
            role: 'parent',
            kindergartenId: null,
            groupId: null,
            specialistType: null,
          },
        ],
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
      await this.tx.run(async (manager) => {
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
