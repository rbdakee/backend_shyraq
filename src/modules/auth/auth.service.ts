import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { AllConfigType } from '@/config/config.type';
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
import { JwtTokenPort } from './jwt-token.port';
import { OtpStorePort } from './otp-store.port';
import { PasswordHasherPort } from './password-hasher.port';
import { RefreshTokenRepository } from './infrastructure/persistence/refresh-token.repository';
import { SaasRefreshTokenRepository } from './infrastructure/persistence/saas-refresh-token.repository';
import { SaasUserRepository } from './infrastructure/persistence/saas-user.repository';
import { SmsPort } from './sms.port';
import { TokenBlocklistPort } from './token-blocklist.port';
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
  ) {}

  onModuleInit(): void {
    const csv =
      this.configService.get('auth.otpTestPhones', { infer: true }) ?? '';
    const set = new Set(
      csv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    this.testPhones = set;
    if (set.size > 0) {
      this.logger.warn(
        `OTP test backdoor active for ${set.size} phone(s) (NODE_ENV=${process.env.NODE_ENV ?? 'unknown'})`,
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

    const role = roles[0].role;
    const kgId = roles[0].kindergartenId;
    const access = await this.jwt.issueAccessToken({
      sub: user.id,
      role,
      kindergarten_id: kgId,
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
    await this.refreshTokens.create({
      userId: input.userId,
      kindergartenId: selectedKindergartenId,
      tokenHash: hashRefreshToken(raw),
      deviceId: input.deviceId ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
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
    const user = await this.saasUsers.findByEmail(input.email);
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
    const staffEntries = await this.staff.findAllActiveByUserId(user.id);

    if (staffEntries.length === 0) {
      const guardianKindergartenIds =
        await this.guardians.listApprovedKindergartenIdsByUserId(user.id);
      if (guardianKindergartenIds.length > 0) {
        return {
          roles: guardianKindergartenIds.map((kgId) => ({
            role: 'parent',
            kindergartenId: kgId,
            groupId: null,
          })),
          kindergartens: guardianKindergartenIds.map((kgId) => ({
            id: kgId,
            name: '',
            slug: '',
          })),
        };
      }
      return {
        roles: [{ role: 'parent', kindergartenId: null, groupId: null }],
        kindergartens: [],
      };
    }

    const roles: RoleView[] = staffEntries.map((s) => ({
      role: s.role,
      kindergartenId: s.kindergartenId,
      groupId: null,
    }));

    // Deduplicate kindergarten ids; names/slugs fetched by client separately.
    const seen = new Set<string>();
    const kindergartens: { id: string; name: string; slug: string }[] = [];
    for (const s of staffEntries) {
      if (!seen.has(s.kindergartenId)) {
        seen.add(s.kindergartenId);
        kindergartens.push({ id: s.kindergartenId, name: '', slug: '' });
      }
    }

    return { roles, kindergartens };
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
