/**
 * IdentityQrService — service-unit suite. Hand-written in-memory fakes for
 * every collaborator (no Jest auto-mock). Covers issuance + scan
 * happy/error paths + per-role allowed_actions + admin bulk-revoke.
 *
 * Test names follow CLAUDE.md §7: `it('returns ...')`, `it('throws ...')`,
 * `it('rejects ...')`. NO `it('should ...')`.
 */
import { UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { UserNotFoundError } from '@/modules/users/domain/errors/user-not-found.error';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import {
  CreateRefreshInput,
  RefreshTokenRepository,
  RotateOpts,
  RotateResult,
} from '@/modules/auth/infrastructure/persistence/refresh-token.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { QrToken } from './domain/entities/qr-token.entity';
import { QrScanRateLimitExceededError } from './domain/errors/qr-scan-rate-limit-exceeded.error';
import { QrTokenExpiredError } from './domain/errors/qr-token-expired.error';
import { QrTokenNotFoundError } from './domain/errors/qr-token-not-found.error';
import { QrTokenRevokedError } from './domain/errors/qr-token-revoked.error';
import {
  computeAllowedActions,
  IdentityQrService,
} from './identity-qr.service';
import { QrTokenCachePort } from './infrastructure/cache/qr-token-cache.port';
import { IdentityQrRepository } from './infrastructure/persistence/identity-qr.repository';
import { QrScanRateLimiterPort } from './infrastructure/rate-limit/qr-scan-rate-limiter.port';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const KG2 = '22222222-2222-2222-2222-222222222222';
const PARENT_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STAFF_MEMBER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ADMIN_USER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SUPER_ADMIN_USER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CHILD_1 = 'cccccccc-1111-1111-1111-111111111111';
const CHILD_2 = 'cccccccc-2222-2222-2222-222222222222';
const DEVICE_ID = 'device-staff-app-android-1';
const NOW = new Date('2026-05-01T09:00:00.000Z');

function sha256Hex(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// ── Clock fake ───────────────────────────────────────────────────────────

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
  set(d: Date): void {
    this.fixed = d;
  }
}

// ── Fake QR repo ─────────────────────────────────────────────────────────

class FakeQrRepo extends IdentityQrRepository {
  rows: QrToken[] = [];

  findActiveByUserAndPurpose(
    userId: string,
    purpose: 'identity',
    now: Date,
  ): Promise<QrToken | null> {
    const candidates = this.rows.filter((t) => {
      const s = t.toState();
      return (
        s.userId === userId &&
        s.purpose === purpose &&
        s.revokedAt === null &&
        s.expiresAt.getTime() > now.getTime()
      );
    });
    if (candidates.length === 0) return Promise.resolve(null);
    candidates.sort(
      (a, b) => b.toState().issuedAt.getTime() - a.toState().issuedAt.getTime(),
    );
    return Promise.resolve(candidates[0]);
  }

  findByTokenHash(tokenHash: string): Promise<QrToken | null> {
    return Promise.resolve(
      this.rows.find((t) => t.toState().tokenHash === tokenHash) ?? null,
    );
  }

  create(token: QrToken): Promise<QrToken> {
    this.rows.push(token);
    return Promise.resolve(token);
  }

  revokeAllByUser(
    userId: string,
    purpose: 'identity',
    now: Date,
  ): Promise<{ revokedHashes: string[] }> {
    const revoked: string[] = [];
    this.rows = this.rows.map((t) => {
      const s = t.toState();
      if (
        s.userId === userId &&
        s.purpose === purpose &&
        s.revokedAt === null
      ) {
        revoked.push(s.tokenHash);
        return QrToken.fromState({ ...s, revokedAt: now });
      }
      return t;
    });
    return Promise.resolve({ revokedHashes: revoked });
  }

  revokeById(id: string, now: Date): Promise<void> {
    this.rows = this.rows.map((t) => {
      const s = t.toState();
      if (s.id === id && s.revokedAt === null) {
        return QrToken.fromState({ ...s, revokedAt: now });
      }
      return t;
    });
    return Promise.resolve();
  }

  updateLastScannedAt(id: string, now: Date): Promise<void> {
    this.rows = this.rows.map((t) => {
      const s = t.toState();
      if (s.id === id) {
        return QrToken.fromState({ ...s, lastScannedAt: now });
      }
      return t;
    });
    return Promise.resolve();
  }

  acquireUserAdvisoryLock(_userId: string): Promise<void> {
    // No-op fake — real PG-backed advisory-lock semantics are exercised
    // by `identity-qr.race.integration.spec.ts`.
    return Promise.resolve();
  }
}

// ── Fake cache ───────────────────────────────────────────────────────────

class FakeCache extends QrTokenCachePort {
  store = new Map<string, string>();
  ttlSec = new Map<string, number>();
  setCalls: Array<{ plaintext: string; userId: string; ttl: number }> = [];
  userStore = new Map<string, string>();
  userTtlSec = new Map<string, number>();
  clearUserCalls: string[] = [];

  setToken(
    plaintext: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void> {
    this.store.set(plaintext, userId);
    this.ttlSec.set(plaintext, ttlSeconds);
    this.setCalls.push({ plaintext, userId, ttl: ttlSeconds });
    return Promise.resolve();
  }
  lookup(plaintext: string): Promise<string | null> {
    return Promise.resolve(this.store.get(plaintext) ?? null);
  }
  revoke(plaintext: string): Promise<void> {
    this.store.delete(plaintext);
    return Promise.resolve();
  }
  setUserActiveToken(
    userId: string,
    plaintext: string,
    ttlSeconds: number,
  ): Promise<void> {
    this.userStore.set(userId, plaintext);
    this.userTtlSec.set(userId, ttlSeconds);
    return Promise.resolve();
  }
  getUserActiveToken(userId: string): Promise<string | null> {
    return Promise.resolve(this.userStore.get(userId) ?? null);
  }
  clearUserActiveToken(userId: string): Promise<void> {
    this.userStore.delete(userId);
    this.clearUserCalls.push(userId);
    return Promise.resolve();
  }
}

// ── Fake rate limiter ────────────────────────────────────────────────────

class FakeRateLimiter extends QrScanRateLimiterPort {
  calls = 0;
  limit = 60;

  check(
    _deviceId: string,
  ): Promise<{ ok: boolean; retryAfterSeconds: number | null }> {
    this.calls += 1;
    if (this.calls > this.limit) {
      return Promise.resolve({ ok: false, retryAfterSeconds: 42 });
    }
    return Promise.resolve({ ok: true, retryAfterSeconds: null });
  }
}

// ── Fake refresh-token repo ──────────────────────────────────────────────

class FakeRefreshTokenRepo extends RefreshTokenRepository {
  validSessions = new Set<string>();

  /** key = `${userId}|${deviceId}` */
  allow(userId: string, deviceId: string): void {
    this.validSessions.add(`${userId}|${deviceId}`);
  }
  create(_input: CreateRefreshInput): Promise<void> {
    return Promise.resolve();
  }
  rotate(_opts: RotateOpts): Promise<RotateResult | null> {
    return Promise.resolve(null);
  }
  revokeByHash(_h: string, _now: Date): Promise<void> {
    return Promise.resolve();
  }
  revokeAllByUserId(_uid: string, _now: Date): Promise<void> {
    return Promise.resolve();
  }
  hasActiveSessionForDevice(
    userId: string,
    deviceId: string,
    _now: Date,
  ): Promise<boolean> {
    return Promise.resolve(this.validSessions.has(`${userId}|${deviceId}`));
  }
}

// ── Fake guardian repo ───────────────────────────────────────────────────

class FakeGuardianRepo extends ChildGuardianRepository {
  approvedActiveByUser = new Map<string, ChildGuardian[]>();

  setApprovedActive(userId: string, guardians: ChildGuardian[]): void {
    this.approvedActiveByUser.set(userId, guardians);
  }

  // unused stubs
  create(_g: ChildGuardian): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByChildId(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findActiveByChildAndUser(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedByChildAndUserCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByIdCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findPendingForPrimary(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  countApprovalRights(): Promise<number> {
    return Promise.resolve(0);
  }
  listApprovedKindergartenIdsByUserId(): Promise<string[]> {
    return Promise.resolve([]);
  }
  findApprovedByUser(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActivePickupGuardian(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<ChildGuardian[]> {
    const all = this.approvedActiveByUser.get(userId) ?? [];
    if (!kindergartenId) return Promise.resolve(all);
    return Promise.resolve(
      all.filter((g) => g.toState().kindergartenId === kindergartenId),
    );
  }
}

// ── Fake child repo ──────────────────────────────────────────────────────

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();
  put(c: Child): void {
    this.byId.set(c.id, c);
  }
  create(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  findById(_kg: string, _id: string): Promise<Child | null> {
    return Promise.resolve(null);
  }
  findByKindergartenAndIin(): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kg: string,
    _f: ChildListFilters,
    _p: PageRequest,
  ): Promise<PageResult<Child>> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(ids: string[]): Promise<Child[]> {
    return Promise.resolve(
      ids.map((id) => this.byId.get(id)).filter((c): c is Child => !!c),
    );
  }
}

// ── Fake staff repo ──────────────────────────────────────────────────────

class FakeStaffRepo extends StaffMemberRepository {
  byUserId = new Map<string, StaffMember[]>();

  setActive(userId: string, members: StaffMember[]): void {
    this.byUserId.set(userId, members);
  }

  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    const candidates = this.byUserId.get(userId) ?? [];
    return Promise.resolve(
      candidates.find((s) => s.toState().kindergartenId === kindergartenId) ??
        null,
    );
  }
  listByKindergarten(
    _kg: string,
    _f?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(s: StaffMember): Promise<StaffMember> {
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(this.byUserId.get(userId) ?? []);
  }
}

// ── Fake users repo ──────────────────────────────────────────────────────

class FakeUserRepo extends UserRepository {
  byId = new Map<string, User>();
  put(u: User): void {
    this.byId.set(u.id, u);
  }
  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByPhone(): Promise<User | null> {
    return Promise.resolve(null);
  }
  upsertByPhone(_p: string): Promise<User> {
    throw new Error('not used');
  }
  update(_id: string, _changes: UserUpdateInput): Promise<User> {
    throw new Error('not used');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeUser(id: string, name = 'Test User'): User {
  return User.hydrate({
    id,
    phone: '+77001112233',
    fullName: name,
    avatarUrl: null,
    iin: null,
    dateOfBirth: null,
    locale: 'ru',
  });
}

function makeChild(id: string, kg: string, name = 'Test Child'): Child {
  return Child.hydrate({
    id,
    kindergartenId: kg,
    iin: null,
    fullName: name,
    dateOfBirth: new Date('2022-01-01'),
    gender: null,
    photoUrl: null,
    status: 'active',
    currentGroupId: null,
    enrollmentDate: NOW,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeStaff(
  id: string,
  kg: string,
  userId: string,
  role: 'admin' | 'mentor' | 'specialist' | 'reception' = 'reception',
): StaffMember {
  return StaffMember.hydrate({
    id,
    kindergartenId: kg,
    userId,
    fullName: 'Test Staff',
    phone: null,
    role,
    specialistType: null,
    isActive: true,
    hiredAt: NOW,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeApprovedGuardian(
  childId: string,
  userId: string,
  kg: string,
  canPickup: boolean,
): ChildGuardian {
  const g = ChildGuardian.createPending({
    id: randomUUID(),
    kindergartenId: KindergartenId.parse(kg),
    childId: ChildId.parse(childId),
    userId: UserId.parse(userId),
    role: GuardianRelation.PRIMARY,
    canPickup,
    now: NOW,
  });
  // Promote to approved (auto-approve as primary stamps approvedAt + has_approval_rights).
  g.autoApproveAsPrimary(NOW);
  return g;
}

// ── System under test factory ───────────────────────────────────────────

interface Sut {
  service: IdentityQrService;
  qrRepo: FakeQrRepo;
  cache: FakeCache;
  rateLimiter: FakeRateLimiter;
  clock: FixedClock;
  refresh: FakeRefreshTokenRepo;
  guardians: FakeGuardianRepo;
  children: FakeChildRepo;
  staff: FakeStaffRepo;
  users: FakeUserRepo;
}

function buildSut(): Sut {
  const qrRepo = new FakeQrRepo();
  const cache = new FakeCache();
  const rateLimiter = new FakeRateLimiter();
  const clock = new FixedClock(NOW);
  const refresh = new FakeRefreshTokenRepo();
  const guardians = new FakeGuardianRepo();
  const children = new FakeChildRepo();
  const staff = new FakeStaffRepo();
  const users = new FakeUserRepo();

  const service = new IdentityQrService(
    qrRepo,
    cache,
    rateLimiter,
    clock,
    refresh,
    guardians,
    children,
    staff,
    users,
  );

  return {
    service,
    qrRepo,
    cache,
    rateLimiter,
    clock,
    refresh,
    guardians,
    children,
    staff,
    users,
  };
}

// ── issueOrRefresh ───────────────────────────────────────────────────────

describe('IdentityQrService.issueOrRefresh', () => {
  it('returns a 32-hex token and stores hash + Redis entry', async () => {
    const sut = buildSut();
    const result = await sut.service.issueOrRefresh(PARENT_USER);

    expect(result.token).toMatch(/^[0-9a-f]{32}$/);
    expect(result.issuedAt).toEqual(NOW);
    expect(result.expiresAt.getTime()).toEqual(
      NOW.getTime() + 24 * 60 * 60 * 1000,
    );

    expect(sut.qrRepo.rows).toHaveLength(1);
    expect(sut.qrRepo.rows[0].toState().tokenHash).toBe(
      sha256Hex(result.token),
    );
    expect(sut.qrRepo.rows[0].toState().userId).toBe(PARENT_USER);
    expect(sut.qrRepo.rows[0].toState().kindergartenId).toBeNull();

    expect(sut.cache.store.get(result.token)).toBe(PARENT_USER);
    expect(sut.cache.ttlSec.get(result.token)).toBe(24 * 60 * 60);
    // Reuse path requires the user-keyed cache entry too.
    expect(sut.cache.userStore.get(PARENT_USER)).toBe(result.token);
    expect(sut.cache.userTtlSec.get(PARENT_USER)).toBe(24 * 60 * 60);
  });

  it('reuses the same plaintext when an active row is fresh (>1h to expiry)', async () => {
    const sut = buildSut();
    const first = await sut.service.issueOrRefresh(PARENT_USER);
    // +1 minute later — well under the 1h refresh threshold.
    sut.clock.set(new Date(NOW.getTime() + 60_000));
    const second = await sut.service.issueOrRefresh(PARENT_USER);

    expect(second.token).toBe(first.token);
    expect(second.issuedAt).toEqual(first.issuedAt);
    expect(second.expiresAt).toEqual(first.expiresAt);
    // Only one DB row total — reuse path takes no DB writes.
    expect(sut.qrRepo.rows).toHaveLength(1);
    expect(sut.qrRepo.rows[0].toState().revokedAt).toBeNull();
  });

  it('mints fresh and revokes the old row when <1h remaining (refresh threshold)', async () => {
    const sut = buildSut();
    const first = await sut.service.issueOrRefresh(PARENT_USER);
    // Advance to 30 min before expiry — under the 1h threshold.
    sut.clock.set(
      new Date(NOW.getTime() + 24 * 60 * 60 * 1000 - 30 * 60 * 1000),
    );
    const second = await sut.service.issueOrRefresh(PARENT_USER);

    expect(second.token).not.toBe(first.token);
    expect(sut.qrRepo.rows).toHaveLength(2);
    const firstRow = sut.qrRepo.rows.find(
      (r) => r.toState().tokenHash === sha256Hex(first.token),
    );
    const secondRow = sut.qrRepo.rows.find(
      (r) => r.toState().tokenHash === sha256Hex(second.token),
    );
    expect(firstRow?.toState().revokedAt).not.toBeNull();
    expect(secondRow?.toState().revokedAt).toBeNull();
  });

  it('mints fresh when the user-keyed cache is empty even if a fresh DB row exists', async () => {
    const sut = buildSut();
    const first = await sut.service.issueOrRefresh(PARENT_USER);
    // Simulate Redis dropping the user-key (eviction / restart) while the
    // DB row is still fresh. The server has no way to recover the
    // plaintext without it, so it must mint fresh.
    sut.cache.userStore.delete(PARENT_USER);
    const second = await sut.service.issueOrRefresh(PARENT_USER);

    expect(second.token).not.toBe(first.token);
    expect(sut.qrRepo.rows).toHaveLength(2);
    const firstRow = sut.qrRepo.rows.find(
      (r) => r.toState().tokenHash === sha256Hex(first.token),
    );
    expect(firstRow?.toState().revokedAt).not.toBeNull();
  });

  it('mints fresh when cached plaintext does not match the active DB row hash', async () => {
    const sut = buildSut();
    const first = await sut.service.issueOrRefresh(PARENT_USER);
    // Stale Redis state: user-key points at a different plaintext than
    // the active row encodes (e.g. admin revoked + cleared user-key + new
    // mint happened, but external poisoning re-set user-key to an old
    // value). The hash defensive-check forces a fresh mint.
    await sut.cache.setUserActiveToken(
      PARENT_USER,
      'a'.repeat(32),
      24 * 60 * 60,
    );
    const second = await sut.service.issueOrRefresh(PARENT_USER);
    expect(second.token).not.toBe(first.token);
  });

  it('always sets kindergarten_id=null on issued rows (cross-tenant)', async () => {
    const sut = buildSut();
    await sut.service.issueOrRefresh(PARENT_USER);
    expect(sut.qrRepo.rows[0].toState().kindergartenId).toBeNull();
  });
});

// ── scan ─────────────────────────────────────────────────────────────────

describe('IdentityQrService.scan — happy paths', () => {
  it('returns only the scanning-kg child in linkedChildren (parent has children in KG and KG2)', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER, 'Parent Sample'));
    sut.children.put(makeChild(CHILD_1, KG, 'Child A'));
    sut.children.put(makeChild(CHILD_2, KG2, 'Child B'));
    sut.guardians.setApprovedActive(PARENT_USER, [
      makeApprovedGuardian(CHILD_1, PARENT_USER, KG, true),
      makeApprovedGuardian(CHILD_2, PARENT_USER, KG2, true),
    ]);

    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    // Staff in KG scans the parent's QR → only the KG child is returned.
    // KG2 child is NOT visible to KG staff even though the QR identity is
    // cross-tenant (one parent → one QR across kindergartens).
    const result = await sut.service.scan(
      STAFF_USER,
      DEVICE_ID,
      issued.token,
      KG,
    );

    expect(result.user.id).toBe(PARENT_USER);
    expect(result.role).toBe('parent');
    expect(result.linkedChildren?.map((c) => c.id)).toEqual([CHILD_1]);
    expect(result.allowedActions).toEqual(['check_in', 'check_out']);
  });

  it('returns empty linkedChildren when parent has no children in scanning kg', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER, 'Parent Sample'));
    sut.children.put(makeChild(CHILD_2, KG2, 'Child B'));
    sut.guardians.setApprovedActive(PARENT_USER, [
      makeApprovedGuardian(CHILD_2, PARENT_USER, KG2, true),
    ]);

    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    // Staff in KG scans a parent whose only child lives in KG2.
    const result = await sut.service.scan(
      STAFF_USER,
      DEVICE_ID,
      issued.token,
      KG,
    );

    expect(result.user.id).toBe(PARENT_USER);
    expect(result.role).toBe('parent');
    expect(result.linkedChildren).toEqual([]);
    // No can_pickup guardian in KG → no actions in the scanning kg.
    expect(result.allowedActions).toEqual([]);
  });

  it('returns gate_entry for staff scan (no linked_children)', async () => {
    const sut = buildSut();
    sut.refresh.allow(ADMIN_USER, DEVICE_ID);
    sut.users.put(makeUser(STAFF_USER, 'Staff Sample'));
    sut.staff.setActive(STAFF_USER, [
      makeStaff(STAFF_MEMBER_ID, KG, STAFF_USER, 'mentor'),
    ]);

    const issued = await sut.service.issueOrRefresh(STAFF_USER);
    const result = await sut.service.scan(
      ADMIN_USER,
      DEVICE_ID,
      issued.token,
      KG,
    );

    expect(result.role).toBe('mentor');
    expect(result.allowedActions).toEqual(['gate_entry']);
    expect(result.linkedChildren).toBeUndefined();
  });

  it('returns empty allowed_actions for super-admin / unknown role', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(SUPER_ADMIN_USER, 'SA'));
    // No staff entries, no guardians → role collapses to 'parent', no pickup → []
    const issued = await sut.service.issueOrRefresh(SUPER_ADMIN_USER);
    const result = await sut.service.scan(
      STAFF_USER,
      DEVICE_ID,
      issued.token,
      KG,
    );
    expect(result.role).toBe('parent');
    expect(result.allowedActions).toEqual([]);
  });

  it('stamps last_scanned_at on the row on success', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER));

    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    sut.clock.set(new Date(NOW.getTime() + 5 * 60_000));
    await sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG);

    const row = sut.qrRepo.rows[0].toState();
    expect(row.lastScannedAt).toEqual(new Date(NOW.getTime() + 5 * 60_000));
  });

  it('returns parent role with empty actions when guardian has can_pickup=false', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER));
    sut.children.put(makeChild(CHILD_1, KG));
    sut.guardians.setApprovedActive(PARENT_USER, [
      makeApprovedGuardian(CHILD_1, PARENT_USER, KG, false),
    ]);

    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    const result = await sut.service.scan(
      STAFF_USER,
      DEVICE_ID,
      issued.token,
      KG,
    );

    expect(result.role).toBe('parent');
    expect(result.allowedActions).toEqual([]);
    expect(result.linkedChildren?.map((c) => c.id)).toEqual([CHILD_1]);
  });
});

describe('IdentityQrService.scan — errors', () => {
  it('throws UnauthorizedException when no active session for device', async () => {
    const sut = buildSut();
    // do NOT call sut.refresh.allow(...)
    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws QrScanRateLimitExceededError after the 60th call in window', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER));
    const issued = await sut.service.issueOrRefresh(PARENT_USER);

    for (let i = 0; i < 60; i++) {
      await sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG);
    }
    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(QrScanRateLimitExceededError);
  });

  it('throws QrTokenNotFoundError when token absent in DB', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, 'a'.repeat(32), KG),
    ).rejects.toBeInstanceOf(QrTokenNotFoundError);
  });

  it('throws QrTokenRevokedError when DB row is revoked', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER));
    // Make the parent an approved guardian in KG so admin revoke is
    // authorized for that kg.
    sut.guardians.setApprovedActive(PARENT_USER, [
      makeApprovedGuardian(CHILD_1, PARENT_USER, KG, true),
    ]);
    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    // Admin revokes (clears user-key + stamps revoked_at on the row).
    // The plaintext-keyed cache stays — that's by design — and the scan
    // path's DB-recheck must surface QrTokenRevokedError despite the
    // cache hit.
    await sut.service.revokeAllByUser(ADMIN_USER, PARENT_USER, KG);

    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(QrTokenRevokedError);
  });

  it('throws QrTokenExpiredError when row is expired', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER));
    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    // advance clock past expiry (24h)
    sut.clock.set(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));

    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(QrTokenExpiredError);
  });

  it('throws QrTokenNotFoundError when scanned user is missing (cascade race)', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    // Issue token but do NOT seed users repo → simulates user soft-deleted
    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(QrTokenNotFoundError);
  });

  it('throws QrTokenNotFoundError when cache user_id mismatches DB row owner', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    sut.users.put(makeUser(PARENT_USER));
    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    // Poison the cache: rewrite the entry to point to a DIFFERENT user.
    await sut.cache.setToken(issued.token, ADMIN_USER, 60);

    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(QrTokenNotFoundError);
  });
});

// ── revokeAllByUser ──────────────────────────────────────────────────────

describe('IdentityQrService.revokeAllByUser', () => {
  /**
   * Make `targetUser` look like an approved guardian in `kg`. The service
   * gates revoke on (active staff_member in kg) OR (approved guardian for
   * a child in kg), so without this setup every revoke would 403.
   */
  function authorizeAsGuardian(sut: Sut, userId: string, kg: string): void {
    sut.users.put(makeUser(userId));
    sut.guardians.setApprovedActive(userId, [
      makeApprovedGuardian(CHILD_1, userId, kg, true),
    ]);
  }

  it('returns revoked_count = 1 after revoking the single active token', async () => {
    const sut = buildSut();
    authorizeAsGuardian(sut, PARENT_USER, KG);
    await sut.service.issueOrRefresh(PARENT_USER);
    const result = await sut.service.revokeAllByUser(
      ADMIN_USER,
      PARENT_USER,
      KG,
    );
    expect(result.revokedCount).toBe(1);
  });

  it('returns revoked_count = 0 when user has no active tokens', async () => {
    const sut = buildSut();
    authorizeAsGuardian(sut, PARENT_USER, KG);
    const result = await sut.service.revokeAllByUser(
      ADMIN_USER,
      PARENT_USER,
      KG,
    );
    expect(result.revokedCount).toBe(0);
  });

  it('subsequent scan of the just-revoked token throws QrTokenRevokedError', async () => {
    const sut = buildSut();
    sut.refresh.allow(STAFF_USER, DEVICE_ID);
    authorizeAsGuardian(sut, PARENT_USER, KG);
    const issued = await sut.service.issueOrRefresh(PARENT_USER);
    await sut.service.revokeAllByUser(ADMIN_USER, PARENT_USER, KG);
    await expect(
      sut.service.scan(STAFF_USER, DEVICE_ID, issued.token, KG),
    ).rejects.toBeInstanceOf(QrTokenRevokedError);
  });

  it('clears the user-keyed reuse cache so the next GET mints fresh', async () => {
    const sut = buildSut();
    authorizeAsGuardian(sut, PARENT_USER, KG);
    const first = await sut.service.issueOrRefresh(PARENT_USER);
    expect(sut.cache.userStore.get(PARENT_USER)).toBe(first.token);

    await sut.service.revokeAllByUser(ADMIN_USER, PARENT_USER, KG);
    expect(sut.cache.clearUserCalls).toContain(PARENT_USER);
    expect(sut.cache.userStore.has(PARENT_USER)).toBe(false);

    // Next GET cannot reuse — falls through to mint a fresh token.
    const second = await sut.service.issueOrRefresh(PARENT_USER);
    expect(second.token).not.toBe(first.token);
  });

  it('throws UserNotFoundError when targetUserId does not exist', async () => {
    const sut = buildSut();
    await expect(
      sut.service.revokeAllByUser(ADMIN_USER, PARENT_USER, KG),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it('throws ForbiddenActionError(user_no_relationship_to_kindergarten) when target is not staff or guardian in caller kg', async () => {
    const sut = buildSut();
    sut.users.put(makeUser(PARENT_USER));
    // No staff entry in KG, no guardian in KG — only a guardian in KG2.
    sut.guardians.setApprovedActive(PARENT_USER, [
      makeApprovedGuardian(CHILD_2, PARENT_USER, KG2, true),
    ]);

    await expect(
      sut.service.revokeAllByUser(ADMIN_USER, PARENT_USER, KG),
    ).rejects.toMatchObject({
      code: 'user_no_relationship_to_kindergarten',
    });
    await expect(
      sut.service.revokeAllByUser(ADMIN_USER, PARENT_USER, KG),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });

  it('allows revoke when target is an active staff_member in caller kg', async () => {
    const sut = buildSut();
    sut.users.put(makeUser(STAFF_USER));
    sut.staff.setActive(STAFF_USER, [
      makeStaff(STAFF_MEMBER_ID, KG, STAFF_USER, 'mentor'),
    ]);
    await sut.service.issueOrRefresh(STAFF_USER);
    const result = await sut.service.revokeAllByUser(
      ADMIN_USER,
      STAFF_USER,
      KG,
    );
    expect(result.revokedCount).toBe(1);
  });
});

// ── computeAllowedActions (pure) ─────────────────────────────────────────

describe('computeAllowedActions', () => {
  it('returns check_in/check_out for parent with at least one can_pickup guardian', () => {
    const guardians = [
      makeApprovedGuardian(CHILD_1, PARENT_USER, KG, false),
      makeApprovedGuardian(CHILD_2, PARENT_USER, KG2, true),
    ];
    expect(computeAllowedActions('parent', guardians)).toEqual([
      'check_in',
      'check_out',
    ]);
  });

  it('returns empty for parent with no can_pickup guardians', () => {
    expect(
      computeAllowedActions('parent', [
        makeApprovedGuardian(CHILD_1, PARENT_USER, KG, false),
      ]),
    ).toEqual([]);
  });

  it('returns gate_entry for any staff role', () => {
    for (const role of ['admin', 'mentor', 'specialist', 'reception']) {
      expect(computeAllowedActions(role, [])).toEqual(['gate_entry']);
    }
  });

  it('returns empty for super_admin / unknown roles', () => {
    expect(computeAllowedActions('super_admin', [])).toEqual([]);
    expect(computeAllowedActions('mystery', [])).toEqual([]);
  });
});
