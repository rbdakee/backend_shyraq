/**
 * AuthService unit tests — in-memory fakes for repositories + ports, no
 * jest.mock. The fakes mirror the abstract port shape so type errors surface
 * the moment a port signature changes.
 */
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import { AuthService } from './auth.service';
import { SaasUser } from './domain/entities/saas-user.entity';
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
import {
  IssueAccessPayload,
  JwtTokenPort,
  IssueAccessResult,
  DecodedAccessClaims,
} from './jwt-token.port';
import { OtpStorePort, StoredOtp } from './otp-store.port';
import { PasswordHasherPort } from './password-hasher.port';
import {
  CreateRefreshInput,
  RefreshTokenRepository,
  RotateOpts,
  RotateResult,
} from './infrastructure/persistence/refresh-token.repository';
import {
  CreateSaasRefreshInput,
  RotateSaasOpts,
  RotateSaasResult,
  SaasRefreshTokenRepository,
} from './infrastructure/persistence/saas-refresh-token.repository';
import { SaasUserRepository } from './infrastructure/persistence/saas-user.repository';
import { SmsPort, SmsSendResult } from './sms.port';
import { TokenBlocklistPort } from './token-blocklist.port';
import {
  computeRefreshExpiresAt,
  generateRefreshToken,
  hashRefreshToken,
} from './refresh-token.helper';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { NotificationPort } from '@/common/notifications/notification.port';

class FixedClock implements ClockPort {
  constructor(private readonly fixed: Date) {}
  now(): Date {
    return this.fixed;
  }
}

class FakeUserRepo extends UserRepository {
  byId = new Map<string, User>();
  byPhone = new Map<string, User>();

  put(user: User): void {
    this.byId.set(user.id, user);
    this.byPhone.set(user.phone, user);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByPhone(phone: string): Promise<User | null> {
    return Promise.resolve(this.byPhone.get(phone) ?? null);
  }
  upsertByPhone(phone: string): Promise<User> {
    const existing = this.byPhone.get(phone);
    if (existing) return Promise.resolve(existing);
    const user = User.hydrate({
      id: `user-${phone}`,
      phone,
      fullName: phone,
      avatarUrl: null,
      iin: null,
      dateOfBirth: null,
      locale: 'ru',
    });
    this.put(user);
    return Promise.resolve(user);
  }
  update(id: string, _changes: UserUpdateInput): Promise<User> {
    const u = this.byId.get(id);
    if (!u) throw new Error('not found');
    return Promise.resolve(u);
  }
}

class FakeSaasUserRepo extends SaasUserRepository {
  byId = new Map<string, SaasUser>();
  byEmail = new Map<string, SaasUser>();
  put(u: SaasUser): void {
    this.byId.set(u.id, u);
    this.byEmail.set(u.email, u);
  }
  findById(id: string): Promise<SaasUser | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByEmail(email: string): Promise<SaasUser | null> {
    return Promise.resolve(this.byEmail.get(email) ?? null);
  }
  updateLastLogin(_id: string, _at: Date): Promise<void> {
    return Promise.resolve();
  }
}

interface InMemoryRow {
  userId: string;
  kindergartenId: string | null;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}
class FakeRefreshRepo extends RefreshTokenRepository {
  rows: InMemoryRow[] = [];
  create(input: CreateRefreshInput): Promise<void> {
    this.rows.push({
      userId: input.userId,
      kindergartenId: input.kindergartenId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    return Promise.resolve();
  }
  rotate(opts: RotateOpts): Promise<RotateResult | null> {
    const row = this.rows.find((r) => r.tokenHash === opts.tokenHash);
    if (!row || row.revokedAt !== null || row.expiresAt <= opts.now) {
      return Promise.resolve(null);
    }
    row.revokedAt = opts.now;
    this.rows.push({
      userId: row.userId,
      kindergartenId: row.kindergartenId,
      tokenHash: opts.newTokenHash,
      expiresAt: opts.newExpiresAt,
      revokedAt: null,
    });
    return Promise.resolve({
      userId: row.userId,
      kindergartenId: row.kindergartenId,
    });
  }
  revokeByHash(tokenHash: string, now: Date): Promise<void> {
    for (const r of this.rows) {
      if (r.tokenHash === tokenHash && r.revokedAt === null) r.revokedAt = now;
    }
    return Promise.resolve();
  }
  revokeAllByUserId(userId: string, now: Date): Promise<void> {
    for (const r of this.rows) {
      if (r.userId === userId && r.revokedAt === null) r.revokedAt = now;
    }
    return Promise.resolve();
  }
  hasActiveSessionForDevice(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface SaasRow {
  saasUserId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}
class FakeSaasRefreshRepo extends SaasRefreshTokenRepository {
  rows: SaasRow[] = [];
  create(input: CreateSaasRefreshInput): Promise<void> {
    this.rows.push({
      saasUserId: input.saasUserId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    return Promise.resolve();
  }
  rotate(opts: RotateSaasOpts): Promise<RotateSaasResult | null> {
    const row = this.rows.find((r) => r.tokenHash === opts.tokenHash);
    if (!row || row.revokedAt !== null || row.expiresAt <= opts.now) {
      return Promise.resolve(null);
    }
    row.revokedAt = opts.now;
    this.rows.push({
      saasUserId: row.saasUserId,
      tokenHash: opts.newTokenHash,
      expiresAt: opts.newExpiresAt,
      revokedAt: null,
    });
    return Promise.resolve({ saasUserId: row.saasUserId });
  }
  revokeByHash(tokenHash: string, now: Date): Promise<void> {
    for (const r of this.rows) {
      if (r.tokenHash === tokenHash && r.revokedAt === null) r.revokedAt = now;
    }
    return Promise.resolve();
  }
  revokeAllBySaasUserId(saasUserId: string, now: Date): Promise<void> {
    for (const r of this.rows) {
      if (r.saasUserId === saasUserId && r.revokedAt === null)
        r.revokedAt = now;
    }
    return Promise.resolve();
  }
}

interface OtpStored {
  code: string;
  attempts: number;
}
class FakeOtpStore extends OtpStorePort {
  rateCounts = new Map<string, number>();
  rateLimit = 5;
  lockedPhones = new Set<string>();
  codes = new Map<string, OtpStored>();
  checkRateLimit(
    phone: string,
    maxPerWindow: number,
    _windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    const next = (this.rateCounts.get(phone) ?? 0) + 1;
    this.rateCounts.set(phone, next);
    return Promise.resolve(next > maxPerWindow ? 'exceeded' : 'ok');
  }
  checkRateLimitGeneric(
    key: string,
    maxPerWindow: number,
    _windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    const next = (this.rateCounts.get(key) ?? 0) + 1;
    this.rateCounts.set(key, next);
    return Promise.resolve(next > maxPerWindow ? 'exceeded' : 'ok');
  }
  isLocked(phone: string): Promise<boolean> {
    return Promise.resolve(this.lockedPhones.has(phone));
  }
  storeCode(phone: string, code: string, _ttlSec: number): Promise<void> {
    this.codes.set(phone, { code, attempts: 0 });
    return Promise.resolve();
  }
  readCode(phone: string): Promise<StoredOtp | null> {
    const entry = this.codes.get(phone);
    return Promise.resolve(entry ? { ...entry } : null);
  }
  incrementAttempts(phone: string): Promise<number> {
    const entry = this.codes.get(phone);
    if (!entry) return Promise.resolve(0);
    entry.attempts += 1;
    return Promise.resolve(entry.attempts);
  }
  lockPhone(phone: string, _ttlSec: number): Promise<void> {
    this.lockedPhones.add(phone);
    return Promise.resolve();
  }
  clearCode(phone: string): Promise<void> {
    this.codes.delete(phone);
    return Promise.resolve();
  }
}

class FakeSms extends SmsPort {
  sent: { phone: string; message: string }[] = [];
  send(phone: string, message: string): Promise<SmsSendResult> {
    this.sent.push({ phone, message });
    return Promise.resolve({ txnId: `txn-${this.sent.length}` });
  }
}

class FakeJwt extends JwtTokenPort {
  counter = 0;
  issueAccessToken(payload: IssueAccessPayload): Promise<IssueAccessResult> {
    this.counter += 1;
    return Promise.resolve({
      token: `access.${payload.sub}.${this.counter}`,
      jti: `jti-${this.counter}`,
      expiresIn: 900,
    });
  }
  decodeWithoutVerify(_token: string): DecodedAccessClaims | null {
    return null;
  }
  verifyAccessToken(_token: string): Promise<{ sub: string; role: string }> {
    return Promise.reject(new Error('not_implemented'));
  }
}

class FakePasswordHasher extends PasswordHasherPort {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hash:${plain}`);
  }
  compare(plain: string, hash: string): Promise<boolean> {
    return Promise.resolve(hash === `hash:${plain}`);
  }
}

class FakeBlocklist extends TokenBlocklistPort {
  blocked = new Set<string>();
  isBlocked(jti: string): Promise<boolean> {
    return Promise.resolve(this.blocked.has(jti));
  }
  blocklist(jti: string, _expUnix: number): Promise<void> {
    this.blocked.add(jti);
    return Promise.resolve();
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  rows: StaffMember[] = [];
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    return Promise.reject(new Error('not implemented'));
  }
  findById(_kg: string, _id: string): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  findActiveByUserAndKindergarten(
    _userId: string,
    _kgId: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  listByKindergarten(
    _kg: string,
    _filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _changes: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(_sm: StaffMember): Promise<StaffMember> {
    return Promise.reject(new Error('not implemented'));
  }
  deactivateAllByKindergarten(_kg: string, _now: Date): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.toState().userId === userId),
    );
  }
}

class FakeGuardianRepo extends ChildGuardianRepository {
  approvedKindergartenIdsByUserId = new Map<string, string[]>();
  guardians = new Map<string, ChildGuardian>();

  put(g: ChildGuardian): void {
    this.guardians.set(g.id, g);
  }

  create(guardian: ChildGuardian): Promise<void> {
    this.put(guardian);
    return Promise.resolve();
  }
  findById(_kg: string, _id: string): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByChildId(_kg: string, _childId: string): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findActiveByChildAndUser(
    _kg: string,
    _childId: string,
    _userId: string,
  ): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedByChildAndUserCrossTenant(
    _childId: string,
    _userId: string,
  ): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByIdCrossTenant(_guardianId: string): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findPendingForPrimary(
    _kindergartenId: string,
    _primaryUserId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  update(guardian: ChildGuardian): Promise<void> {
    this.put(guardian);
    return Promise.resolve();
  }
  countApprovalRights(_kg: string, _childId: string): Promise<number> {
    return Promise.resolve(0);
  }
  acquireApprovalRightsLock(_kg: string, _childId: string): Promise<void> {
    return Promise.resolve();
  }
  listApprovedKindergartenIdsByUserId(userId: string): Promise<string[]> {
    return Promise.resolve(
      this.approvedKindergartenIdsByUserId.get(userId) ?? [],
    );
  }
  findApprovedByUser(
    _kindergartenId: string,
    _userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findPendingPrimaryByUserIdCrossTenant(
    userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.userId === userId &&
          g.role.value === 'primary' &&
          g.status.value === 'pending_approval',
      ),
    );
  }
  findApprovedActivePickupGuardian(
    _kg: string,
    _childId: string,
    _userId: string,
  ): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(
    _userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActiveByUserAndChild(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
}

class FakeNotificationPort extends NotificationPort {
  approved: {
    kindergartenId: string;
    childId: string;
    guardianUserId: string;
  }[] = [];

  notifyGuardianApproved(e: {
    kindergartenId: string;
    childId: string;
    guardianUserId: string;
    approvedBy: string;
    hasApprovalRights: boolean;
  }): Promise<void> {
    this.approved.push({
      kindergartenId: e.kindergartenId,
      childId: e.childId,
      guardianUserId: e.guardianUserId,
    });
    return Promise.resolve();
  }
  notifyGuardianPendingApproval(): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianRejected(): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianRevoked(): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianSelfRevoked(): Promise<void> {
    return Promise.resolve();
  }
  notifyChildTransferred(): Promise<void> {
    return Promise.resolve();
  }
  notifyPermissionsUpdated(): Promise<void> {
    return Promise.resolve();
  }
  notifyAttendanceCheckIn(): Promise<void> {
    return Promise.resolve();
  }
  notifyAttendanceCheckOut(): Promise<void> {
    return Promise.resolve();
  }
  notifyDailyStatusChanged(): Promise<void> {
    return Promise.resolve();
  }
  notifyTimelineEntryCreated(): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupOtpSent(): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupValidated(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestAccepted(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestRejected(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestCancelled(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestMessageSent(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceCreated(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoicePaid(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceOverdue(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceCancelled(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentCompleted(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentFailed(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentRefunded(): Promise<void> {
    return Promise.resolve();
  }
  notifyRefundProcessed(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Minimal stub of TypeORM DataSource. AuthService.autoApprovePendingPrimaries
 * uses `dataSource.transaction(cb)` to scope each pending-primary update
 * inside its own tenant TX. The in-memory test only needs the lambda to run
 * with a fake manager whose `query()` is a no-op.
 */
const fakeManager = {
  query: (_sql: string): Promise<unknown> => Promise.resolve(undefined),
} as unknown as EntityManager;

const fakeDataSource = {
  transaction: <T>(cb: (m: EntityManager) => Promise<T>): Promise<T> =>
    cb(fakeManager),
} as unknown as DataSource;

interface AuthDeps {
  service: AuthService;
  users: FakeUserRepo;
  saasUsers: FakeSaasUserRepo;
  refresh: FakeRefreshRepo;
  saasRefresh: FakeSaasRefreshRepo;
  otpStore: FakeOtpStore;
  sms: FakeSms;
  jwt: FakeJwt;
  passwords: FakePasswordHasher;
  blocklist: FakeBlocklist;
  staffRepo: FakeStaffRepo;
  guardianRepo: FakeGuardianRepo;
  notifications: FakeNotificationPort;
}

function build(): AuthDeps {
  const users = new FakeUserRepo();
  const saasUsers = new FakeSaasUserRepo();
  const refresh = new FakeRefreshRepo();
  const saasRefresh = new FakeSaasRefreshRepo();
  const otpStore = new FakeOtpStore();
  const sms = new FakeSms();
  const jwt = new FakeJwt();
  const passwords = new FakePasswordHasher();
  const blocklist = new FakeBlocklist();
  const staffRepo = new FakeStaffRepo();
  const guardianRepo = new FakeGuardianRepo();
  const notifications = new FakeNotificationPort();
  const config = new ConfigService<Record<string, unknown>>({
    auth: {
      jwtAccessSecret: 'test-secret-test-secret-test',
      jwtAccessTtl: '15m',
      refreshTokenTtlDays: 30,
      bcryptCost: 4,
      otpLength: 6,
      otpTtlSeconds: 300,
      rateLimitOtpRequestLimit: 5,
      rateLimitOtpRequestWindowSec: 3600,
      rateLimitSuperAdminLoginLimit: 10,
      rateLimitSuperAdminLoginWindowSec: 3600,
      otpTestPhones: '',
      otpTestCode: '000000',
    },
  });
  const service = new AuthService(
    users,
    saasUsers,
    refresh,
    saasRefresh,
    otpStore,
    sms,
    jwt,
    passwords,
    blocklist,
    new FixedClock(new Date('2025-01-01T00:00:00Z')),
    config as unknown as ConfigService,
    staffRepo,
    guardianRepo,
    fakeDataSource,
    notifications,
  );
  service.onModuleInit();
  return {
    service,
    users,
    saasUsers,
    refresh,
    saasRefresh,
    otpStore,
    sms,
    jwt,
    passwords,
    blocklist,
    staffRepo,
    guardianRepo,
    notifications,
  };
}

describe('AuthService', () => {
  describe('requestOtp', () => {
    it('stores a 6-digit code and dispatches SMS', async () => {
      const { service, otpStore, sms } = build();
      const result = await service.requestOtp('+77012345678');
      expect(result.resendAfterSec).toBe(60);
      const stored = await otpStore.readCode('+77012345678');
      expect(stored?.code).toMatch(/^\d{6}$/);
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].phone).toBe('+77012345678');
    });

    it('throws OtpRateLimitedError when 6th call within window', async () => {
      const { service } = build();
      for (let i = 0; i < 5; i++) {
        await service.requestOtp('+77012345678');
      }
      await expect(service.requestOtp('+77012345678')).rejects.toBeInstanceOf(
        OtpRateLimitedError,
      );
    });

    it('throws OtpLockedError when phone is locked', async () => {
      const { service, otpStore } = build();
      otpStore.lockedPhones.add('+77012345678');
      await expect(service.requestOtp('+77012345678')).rejects.toBeInstanceOf(
        OtpLockedError,
      );
    });
  });

  describe('onModuleInit — OTP_TEST_PHONES production guard', () => {
    const TEST_PHONE = '+77099999999';

    function buildWithTestPhone(nodeEnv: string | undefined): AuthDeps {
      const users = new FakeUserRepo();
      const saasUsers = new FakeSaasUserRepo();
      const refresh = new FakeRefreshRepo();
      const saasRefresh = new FakeSaasRefreshRepo();
      const otpStore = new FakeOtpStore();
      const sms = new FakeSms();
      const jwt = new FakeJwt();
      const passwords = new FakePasswordHasher();
      const blocklist = new FakeBlocklist();
      const staffRepo = new FakeStaffRepo();
      const guardianRepo = new FakeGuardianRepo();
      const notifications = new FakeNotificationPort();
      const config = new ConfigService<Record<string, unknown>>({
        auth: {
          jwtAccessSecret: 'test-secret-test-secret-test',
          jwtAccessTtl: '15m',
          refreshTokenTtlDays: 30,
          bcryptCost: 4,
          otpLength: 6,
          otpTtlSeconds: 300,
          rateLimitOtpRequestLimit: 5,
          rateLimitOtpRequestWindowSec: 3600,
          rateLimitSuperAdminLoginLimit: 10,
          rateLimitSuperAdminLoginWindowSec: 3600,
          otpTestPhones: TEST_PHONE,
          otpTestCode: '000000',
        },
      });
      const service = new AuthService(
        users,
        saasUsers,
        refresh,
        saasRefresh,
        otpStore,
        sms,
        jwt,
        passwords,
        blocklist,
        new FixedClock(new Date('2025-01-01T00:00:00Z')),
        config as unknown as ConfigService,
        staffRepo,
        guardianRepo,
        fakeDataSource,
        notifications,
      );
      const saved = process.env.NODE_ENV;
      if (nodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = nodeEnv;
      }
      service.onModuleInit();
      if (saved === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = saved;
      }
      return {
        service,
        users,
        saasUsers,
        refresh,
        saasRefresh,
        otpStore,
        sms,
        jwt,
        passwords,
        blocklist,
        staffRepo,
        guardianRepo,
        notifications,
      };
    }

    it('honours OTP_TEST_PHONES in development (no real SMS sent)', async () => {
      const { service, otpStore, sms } = buildWithTestPhone('development');
      await service.requestOtp(TEST_PHONE);
      // Test phone → no SMS dispatched
      expect(sms.sent).toHaveLength(0);
      const stored = await otpStore.readCode(TEST_PHONE);
      // Fixed test code from config
      expect(stored?.code).toBe('000000');
    });

    it('sends a real random code for non-test phone in development', async () => {
      const { service, sms } = buildWithTestPhone('development');
      const normalPhone = '+77011111111';
      await service.requestOtp(normalPhone);
      expect(sms.sent).toHaveLength(1);
    });

    it('ignores OTP_TEST_PHONES in production and sends real SMS', async () => {
      const { service, otpStore, sms } = buildWithTestPhone('production');
      await service.requestOtp(TEST_PHONE);
      // Production: backdoor disabled → real SMS dispatched
      expect(sms.sent).toHaveLength(1);
      const stored = await otpStore.readCode(TEST_PHONE);
      // Production code is random, not the fixed test code
      expect(stored?.code).not.toBe('000000');
    });
  });

  describe('verifyOtp', () => {
    it('happy path issues access + refresh + parent role', async () => {
      const { service, otpStore } = build();
      await otpStore.storeCode('+77012345678', '123456', 300);
      const res = await service.verifyOtp({
        phone: '+77012345678',
        code: '123456',
      });
      expect(res.accessToken).toMatch(/^access\./);
      expect(res.refreshToken).not.toBeNull();
      expect(res.refreshToken!.length).toBe(64);
      expect(res.pendingRoleSelect).toBe(false);
      expect(res.roles).toEqual([
        { role: 'parent', kindergartenId: null, groupId: null },
      ]);
    });

    it('scopes parent role when the user has an approved guardian row', async () => {
      const { service, otpStore, guardianRepo } = build();
      await otpStore.storeCode('+77012345678', '123456', 300);
      guardianRepo.approvedKindergartenIdsByUserId.set('user-+77012345678', [
        'kg-1',
      ]);

      const res = await service.verifyOtp({
        phone: '+77012345678',
        code: '123456',
      });

      expect(res.pendingRoleSelect).toBe(false);
      expect(res.roles).toEqual([
        { role: 'parent', kindergartenId: 'kg-1', groupId: null },
      ]);
      expect(res.kindergartens).toEqual([{ id: 'kg-1', name: '', slug: '' }]);
    });

    it('throws OtpExpiredError when no code stored', async () => {
      const { service } = build();
      await expect(
        service.verifyOtp({ phone: '+77012345678', code: '123456' }),
      ).rejects.toBeInstanceOf(OtpExpiredError);
    });

    it('throws OtpInvalidError on first wrong code', async () => {
      const { service, otpStore } = build();
      await otpStore.storeCode('+77012345678', '123456', 300);
      await expect(
        service.verifyOtp({ phone: '+77012345678', code: '000000' }),
      ).rejects.toBeInstanceOf(OtpInvalidError);
    });

    it('locks phone after 3 wrong codes', async () => {
      const { service, otpStore } = build();
      await otpStore.storeCode('+77012345678', '123456', 300);
      await expect(
        service.verifyOtp({ phone: '+77012345678', code: '000000' }),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        service.verifyOtp({ phone: '+77012345678', code: '111111' }),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        service.verifyOtp({ phone: '+77012345678', code: '222222' }),
      ).rejects.toBeInstanceOf(OtpLockedError);
      expect(otpStore.lockedPhones.has('+77012345678')).toBe(true);
    });

    it('consumes the OTP — replay rejects with OtpExpiredError', async () => {
      const { service, otpStore } = build();
      await otpStore.storeCode('+77012345678', '123456', 300);
      await service.verifyOtp({ phone: '+77012345678', code: '123456' });
      await expect(
        service.verifyOtp({ phone: '+77012345678', code: '123456' }),
      ).rejects.toBeInstanceOf(OtpExpiredError);
    });
  });

  describe('verifyOtp auto-approve hook', () => {
    const KG_A = '11111111-1111-1111-1111-111111111111';
    const KG_B = '22222222-2222-2222-2222-222222222222';
    const CHILD_A = '33333333-3333-3333-3333-333333333333';
    const CHILD_B = '44444444-4444-4444-4444-444444444444';
    const USER_ID = '55555555-5555-5555-5555-555555555555';
    const PHONE = '+77012345678';

    /**
     * The default FakeUserRepo.upsertByPhone hashes phone → `user-${phone}`,
     * which is not a UUID and would fail UserId.parse inside
     * `ChildGuardian.autoApproveAsPrimary`. Pre-seed a UUID-id user under the
     * test phone so verifyOtp's upsertByPhone short-circuits to the seeded row.
     */
    function seedUuidUser(deps: AuthDeps): void {
      deps.users.put(
        User.hydrate({
          id: USER_ID,
          phone: PHONE,
          fullName: '',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
    }

    function seedPendingPrimary(
      repo: FakeGuardianRepo,
      args: {
        id?: string;
        userId: string;
        kindergartenId: string;
        childId: string;
        role?: 'primary' | 'secondary' | 'nanny';
        status?: 'pending_approval' | 'approved' | 'rejected' | 'revoked';
      },
    ): ChildGuardian {
      const g = ChildGuardian.hydrate({
        id: args.id ?? '66666666-6666-6666-6666-666666666666',
        kindergartenId: args.kindergartenId,
        childId: args.childId,
        userId: args.userId,
        role: args.role ?? 'primary',
        status: args.status ?? 'pending_approval',
        hasApprovalRights: false,
        approvedBy: null,
        approvedAt: null,
        revokedBy: null,
        revokedAt: null,
        canPickup: true,
        permissions: {},
        permissionsUpdatedBy: null,
        permissionsUpdatedAt: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-01T00:00:00Z'),
      });
      repo.put(g);
      return g;
    }

    it('auto-approves a single pending-primary on otp verify', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore, guardianRepo } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);
      const seeded = seedPendingPrimary(guardianRepo, {
        userId: USER_ID,
        kindergartenId: KG_A,
        childId: CHILD_A,
      });

      await service.verifyOtp({ phone: PHONE, code: '123456' });

      const after = guardianRepo.guardians.get(seeded.id);
      expect(after?.status.value).toBe('approved');
      expect(after?.hasApprovalRights).toBe(true);
      expect(after?.approvedBy).toBe(USER_ID);
    });

    it('auto-approves multiple pending-primaries across kindergartens', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore, guardianRepo } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);
      const a = seedPendingPrimary(guardianRepo, {
        id: '77777777-7777-7777-7777-777777777777',
        userId: USER_ID,
        kindergartenId: KG_A,
        childId: CHILD_A,
      });
      const b = seedPendingPrimary(guardianRepo, {
        id: '88888888-8888-8888-8888-888888888888',
        userId: USER_ID,
        kindergartenId: KG_B,
        childId: CHILD_B,
      });

      await service.verifyOtp({ phone: PHONE, code: '123456' });

      expect(guardianRepo.guardians.get(a.id)?.status.value).toBe('approved');
      expect(guardianRepo.guardians.get(b.id)?.status.value).toBe('approved');
      expect(guardianRepo.guardians.get(a.id)?.hasApprovalRights).toBe(true);
      expect(guardianRepo.guardians.get(b.id)?.hasApprovalRights).toBe(true);
    });

    it('returns auth result unchanged when there are no pending-primaries', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);

      const res = await service.verifyOtp({
        phone: PHONE,
        code: '123456',
      });

      expect(res.accessToken).toMatch(/^access\./);
      expect(res.refreshToken).not.toBeNull();
      expect(res.pendingRoleSelect).toBe(false);
    });

    it('does not auto-approve a pending-secondary row', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore, guardianRepo } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);
      const sec = seedPendingPrimary(guardianRepo, {
        userId: USER_ID,
        kindergartenId: KG_A,
        childId: CHILD_A,
        role: 'secondary',
      });

      await service.verifyOtp({ phone: PHONE, code: '123456' });

      const after = guardianRepo.guardians.get(sec.id);
      expect(after?.status.value).toBe('pending_approval');
      expect(after?.hasApprovalRights).toBe(false);
    });

    it('does not auto-approve an already-approved primary row', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore, guardianRepo } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);
      const approved = seedPendingPrimary(guardianRepo, {
        userId: USER_ID,
        kindergartenId: KG_A,
        childId: CHILD_A,
        status: 'approved',
      });

      await service.verifyOtp({ phone: '+77012345678', code: '123456' });

      // Should remain in its original (approved) state — no idempotent retouch.
      const after = guardianRepo.guardians.get(approved.id);
      expect(after?.status.value).toBe('approved');
    });

    it('emits notifyGuardianApproved for each auto-approved primary', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore, guardianRepo, notifications } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);
      seedPendingPrimary(guardianRepo, {
        id: '77777777-7777-7777-7777-777777777777',
        userId: USER_ID,
        kindergartenId: KG_A,
        childId: CHILD_A,
      });
      seedPendingPrimary(guardianRepo, {
        id: '88888888-8888-8888-8888-888888888888',
        userId: USER_ID,
        kindergartenId: KG_B,
        childId: CHILD_B,
      });

      await service.verifyOtp({ phone: PHONE, code: '123456' });

      expect(notifications.approved).toHaveLength(2);
      expect(notifications.approved.map((e) => e.kindergartenId)).toEqual(
        expect.arrayContaining([KG_A, KG_B]),
      );
      expect(notifications.approved.map((e) => e.guardianUserId)).toEqual(
        expect.arrayContaining([USER_ID, USER_ID]),
      );
    });

    it('does not emit notifyGuardianApproved when there are no pending-primaries', async () => {
      const deps = build();
      seedUuidUser(deps);
      const { service, otpStore, notifications } = deps;
      await otpStore.storeCode(PHONE, '123456', 300);

      await service.verifyOtp({ phone: PHONE, code: '123456' });

      expect(notifications.approved).toHaveLength(0);
    });
  });

  describe('refreshToken', () => {
    it('rotates a valid refresh and issues a new access', async () => {
      const { service, refresh, users } = build();
      const raw = generateRefreshToken();
      await refresh.create({
        userId: 'user-1',
        kindergartenId: null,
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });
      users.put(
        User.hydrate({
          id: 'user-1',
          phone: '+77000000000',
          fullName: 'X',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
      const res = await service.refreshToken({ rawRefreshToken: raw });
      expect(res.refreshToken).not.toBeNull();
      expect(res.refreshToken).not.toBe(raw);
      // old row revoked
      const old = refresh.rows.find(
        (r) => r.tokenHash === hashRefreshToken(raw),
      );
      expect(old?.revokedAt).not.toBeNull();
    });

    it('rejects an unknown refresh token with RefreshInvalidError', async () => {
      const { service } = build();
      await expect(
        service.refreshToken({ rawRefreshToken: 'no-such-token' }),
      ).rejects.toBeInstanceOf(RefreshInvalidError);
    });

    it('rejects an expired refresh with RefreshInvalidError', async () => {
      const { service, refresh } = build();
      const raw = generateRefreshToken();
      await refresh.create({
        userId: 'user-1',
        kindergartenId: null,
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: new Date('2024-01-01'), // before fixed clock 2025-01-01
      });
      await expect(
        service.refreshToken({ rawRefreshToken: raw }),
      ).rejects.toBeInstanceOf(RefreshInvalidError);
    });

    it('rejects a revoked refresh with RefreshInvalidError', async () => {
      const { service, refresh } = build();
      const raw = generateRefreshToken();
      await refresh.create({
        userId: 'user-1',
        kindergartenId: null,
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });
      refresh.rows[0].revokedAt = new Date('2025-01-01');
      await expect(
        service.refreshToken({ rawRefreshToken: raw }),
      ).rejects.toBeInstanceOf(RefreshInvalidError);
    });

    it('preserves the original session kg/role even when user has roles in other kindergartens', async () => {
      // Original session: parent in kg-B. User has since gained a staff role
      // in kg-A. Refresh must NOT silently jump to kg-A staff.
      const { service, refresh, users, guardianRepo, staffRepo, jwt } = build();
      const userId = 'user-1';
      users.put(
        User.hydrate({
          id: userId,
          phone: '+77000000000',
          fullName: 'X',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
      // Parent guardian link in kg-B (rotated session origin)
      guardianRepo.approvedKindergartenIdsByUserId.set(userId, ['kg-B']);
      // Plus a staff_member row in kg-A — added after the refresh row was issued
      staffRepo.rows.push(
        StaffMember.hydrate({
          id: 'staff-1',
          kindergartenId: 'kg-A',
          userId,
          fullName: 'X',
          phone: null,
          role: 'admin',
          specialistType: null,
          isActive: true,
          hiredAt: new Date('2025-01-01'),
          firedAt: null,
          archivedAt: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        }),
      );
      const raw = generateRefreshToken();
      await refresh.create({
        userId,
        kindergartenId: 'kg-B', // session was originally for kg-B parent
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });

      const issueSpy = jest.spyOn(jwt, 'issueAccessToken');
      const res = await service.refreshToken({ rawRefreshToken: raw });

      expect(issueSpy).toHaveBeenCalledTimes(1);
      const claims = issueSpy.mock.calls[0][0];
      expect(claims.role).toBe('parent');
      expect(claims.kindergarten_id).toBe('kg-B');
      // Response still surfaces all current associations for role-switch UI
      expect(
        res.roles.some(
          (r) => r.role === 'admin' && r.kindergartenId === 'kg-A',
        ),
      ).toBe(true);
      expect(
        res.roles.some(
          (r) => r.role === 'parent' && r.kindergartenId === 'kg-B',
        ),
      ).toBe(true);
    });

    it('throws NoActiveRolesError when the user has no role in the rotated kg anymore', async () => {
      // Refresh row says kg-B, but the guardian link has since been revoked
      // (so assembleRoles returns no kg-B row).
      const { service, refresh, users, guardianRepo, staffRepo } = build();
      const userId = 'user-1';
      users.put(
        User.hydrate({
          id: userId,
          phone: '+77000000000',
          fullName: 'X',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
      // User now only has staff role in kg-A; no longer guardian in kg-B
      staffRepo.rows.push(
        StaffMember.hydrate({
          id: 'staff-1',
          kindergartenId: 'kg-A',
          userId,
          fullName: 'X',
          phone: null,
          role: 'admin',
          specialistType: null,
          isActive: true,
          hiredAt: new Date('2025-01-01'),
          firedAt: null,
          archivedAt: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        }),
      );
      guardianRepo.approvedKindergartenIdsByUserId.set(userId, []);
      const raw = generateRefreshToken();
      await refresh.create({
        userId,
        kindergartenId: 'kg-B',
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });

      await expect(
        service.refreshToken({ rawRefreshToken: raw }),
      ).rejects.toBeInstanceOf(NoActiveRolesError);
    });

    it('prefers staff role over parent when both exist in the rotated kg', async () => {
      const { service, refresh, users, guardianRepo, staffRepo, jwt } = build();
      const userId = 'user-1';
      users.put(
        User.hydrate({
          id: userId,
          phone: '+77000000000',
          fullName: 'X',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
      // Same kg holds both staff_member and approved guardian for this user
      staffRepo.rows.push(
        StaffMember.hydrate({
          id: 'staff-1',
          kindergartenId: 'kg-A',
          userId,
          fullName: 'X',
          phone: null,
          role: 'admin',
          specialistType: null,
          isActive: true,
          hiredAt: new Date('2025-01-01'),
          firedAt: null,
          archivedAt: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        }),
      );
      guardianRepo.approvedKindergartenIdsByUserId.set(userId, ['kg-A']);
      const raw = generateRefreshToken();
      await refresh.create({
        userId,
        kindergartenId: 'kg-A',
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });

      const issueSpy = jest.spyOn(jwt, 'issueAccessToken');
      await service.refreshToken({ rawRefreshToken: raw });

      // assembleRoles short-circuits on staff: when staff_members for the user
      // is non-empty, parent role is not added (see assembleRoles). The
      // selection still must yield staff (admin), not parent, for kg-A.
      const claims = issueSpy.mock.calls[0][0];
      expect(claims.role).toBe('admin');
      expect(claims.kindergarten_id).toBe('kg-A');
    });

    it('preserves legacy parent-with-null-kg session unchanged', async () => {
      // Refresh row stored kindergartenId=null (legacy parent token before
      // per-kg scoping). User has no staff and no guardian rows → only the
      // implicit parent-null row in assembleRoles. Rotation must keep null.
      const { service, refresh, users, jwt } = build();
      const userId = 'user-1';
      users.put(
        User.hydrate({
          id: userId,
          phone: '+77000000000',
          fullName: 'X',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
      const raw = generateRefreshToken();
      await refresh.create({
        userId,
        kindergartenId: null,
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });

      const issueSpy = jest.spyOn(jwt, 'issueAccessToken');
      await service.refreshToken({ rawRefreshToken: raw });

      const claims = issueSpy.mock.calls[0][0];
      expect(claims.role).toBe('parent');
      expect(claims.kindergarten_id).toBeNull();
    });
  });

  describe('logout', () => {
    it('revokes a specific refresh and blocklists the access JTI', async () => {
      const { service, refresh, blocklist } = build();
      const raw = generateRefreshToken();
      await refresh.create({
        userId: 'user-1',
        kindergartenId: null,
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });
      await service.logout({
        userId: 'user-1',
        rawRefreshToken: raw,
        accessJti: 'jti-acc',
        accessExpUnix: Math.floor(Date.now() / 1000) + 900,
      });
      expect(refresh.rows[0].revokedAt).not.toBeNull();
      expect(blocklist.blocked.has('jti-acc')).toBe(true);
    });

    it('revokes ALL the user’s refresh tokens when no specific token given', async () => {
      const { service, refresh } = build();
      for (let i = 0; i < 3; i++) {
        await refresh.create({
          userId: 'user-1',
          kindergartenId: null,
          tokenHash: `hash-${i}`,
          deviceId: null,
          ipAddress: null,
          expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
        });
      }
      await service.logout({ userId: 'user-1' });
      expect(refresh.rows.every((r) => r.revokedAt !== null)).toBe(true);
    });
  });

  describe('selectRole', () => {
    it('throws RoleSelectNotRequiredError when pendingRoleSelect is false', async () => {
      const { service } = build();
      await expect(
        service.selectRole({
          userId: 'user-1',
          kindergartenId: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
          role: 'teacher',
          pendingRoleSelect: false,
        }),
      ).rejects.toBeInstanceOf(RoleSelectNotRequiredError);
    });

    it('throws RoleNotAvailableError when pendingRoleSelect is true but role not available', async () => {
      const { service } = build();
      await expect(
        service.selectRole({
          userId: 'user-1',
          kindergartenId: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
          role: 'teacher',
          pendingRoleSelect: true,
        }),
      ).rejects.toBeInstanceOf(RoleNotAvailableError);
    });

    it('allows selecting a parent kindergarten from approved guardian rows', async () => {
      const { service, users, guardianRepo } = build();
      users.put(
        User.hydrate({
          id: 'user-1',
          phone: '+77000000001',
          fullName: 'Parent',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'ru',
        }),
      );
      guardianRepo.approvedKindergartenIdsByUserId.set('user-1', ['kg-1']);

      const res = await service.selectRole({
        userId: 'user-1',
        kindergartenId: 'kg-1',
        role: 'parent',
        pendingRoleSelect: true,
      });

      expect(res.roles).toEqual([
        { role: 'parent', kindergartenId: 'kg-1', groupId: null },
      ]);
      expect(res.refreshToken).not.toBeNull();
    });
  });

  describe('superAdminLogin', () => {
    function seedSaasUser(deps: AuthDeps): void {
      deps.saasUsers.put(
        SaasUser.hydrate({
          id: 'sa-1',
          email: 'admin@shyraq.local',
          phone: null,
          fullName: 'Admin',
          passwordHash: 'hash:admin123',
          role: 'super_admin',
          isActive: true,
          lastLoginAt: null,
        }),
      );
    }

    it('issues tokens on valid credentials', async () => {
      const deps = build();
      seedSaasUser(deps);
      const res = await deps.service.superAdminLogin({
        email: 'admin@shyraq.local',
        password: 'admin123',
      });
      expect(res.refreshToken).toBeTruthy();
      expect(res.roles[0].role).toBe('super_admin');
    });

    it('rejects bad email with InvalidCredentialsError', async () => {
      const { service } = build();
      await expect(
        service.superAdminLogin({
          email: 'nobody@nowhere.test',
          password: 'whatever1',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('rejects wrong password with InvalidCredentialsError', async () => {
      const deps = build();
      seedSaasUser(deps);
      await expect(
        deps.service.superAdminLogin({
          email: 'admin@shyraq.local',
          password: 'wrong-pass',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('rejects inactive user with InvalidCredentialsError', async () => {
      const deps = build();
      deps.saasUsers.put(
        SaasUser.hydrate({
          id: 'sa-2',
          email: 'inactive@shyraq.local',
          phone: null,
          fullName: 'X',
          passwordHash: 'hash:admin123',
          role: 'super_admin',
          isActive: false,
          lastLoginAt: null,
        }),
      );
      await expect(
        deps.service.superAdminLogin({
          email: 'inactive@shyraq.local',
          password: 'admin123',
        }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('throws SaasLoginRateLimitError after exceeding 10/hour', async () => {
      const deps = build();
      seedSaasUser(deps);
      // Drive rate-limit counter past 10
      for (let i = 0; i < 10; i++) {
        await deps.service.superAdminLogin({
          email: 'admin@shyraq.local',
          password: 'admin123',
        });
      }
      await expect(
        deps.service.superAdminLogin({
          email: 'admin@shyraq.local',
          password: 'admin123',
        }),
      ).rejects.toBeInstanceOf(SaasLoginRateLimitError);
    });

    it('normalises email case before rate-limiting', async () => {
      const deps = build();
      seedSaasUser(deps);
      // 5 requests from mixed-case variant
      for (let i = 0; i < 5; i++) {
        await deps.service.superAdminLogin({
          email: 'ADMIN@shyraq.local',
          password: 'admin123',
        });
      }
      // 5 more from lowercase — should share the same counter (total 10 → next hits 11)
      for (let i = 0; i < 5; i++) {
        await deps.service.superAdminLogin({
          email: 'admin@shyraq.local',
          password: 'admin123',
        });
      }
      await expect(
        deps.service.superAdminLogin({
          email: 'admin@shyraq.local',
          password: 'admin123',
        }),
      ).rejects.toBeInstanceOf(SaasLoginRateLimitError);
    });
  });

  describe('superAdminRefresh', () => {
    it('rotates a SaaS refresh token', async () => {
      const deps = build();
      deps.saasUsers.put(
        SaasUser.hydrate({
          id: 'sa-1',
          email: 'a@b',
          phone: null,
          fullName: 'X',
          passwordHash: 'hash:p',
          role: 'support',
          isActive: true,
          lastLoginAt: null,
        }),
      );
      const raw = generateRefreshToken();
      await deps.saasRefresh.create({
        saasUserId: 'sa-1',
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });
      const res = await deps.service.superAdminRefresh({
        rawRefreshToken: raw,
      });
      expect(res.refreshToken).not.toBe(raw);
    });

    it('rejects unknown SaaS refresh with RefreshInvalidError', async () => {
      const { service } = build();
      await expect(
        service.superAdminRefresh({ rawRefreshToken: 'unknown' }),
      ).rejects.toBeInstanceOf(RefreshInvalidError);
    });
  });

  describe('superAdminLogout', () => {
    it('revokes the refresh and blocklists the access JTI', async () => {
      const { service, saasRefresh, blocklist } = build();
      const raw = generateRefreshToken();
      await saasRefresh.create({
        saasUserId: 'sa-1',
        tokenHash: hashRefreshToken(raw),
        deviceId: null,
        ipAddress: null,
        expiresAt: computeRefreshExpiresAt(new Date('2025-01-01'), 30),
      });
      await service.superAdminLogout({
        saasUserId: 'sa-1',
        rawRefreshToken: raw,
        accessJti: 'jti-acc',
        accessExpUnix: Math.floor(Date.now() / 1000) + 900,
      });
      expect(saasRefresh.rows[0].revokedAt).not.toBeNull();
      expect(blocklist.blocked.has('jti-acc')).toBe(true);
    });
  });
});
