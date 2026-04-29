import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { SmsPort, SmsSendResult } from '@/modules/auth/sms.port';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import {
  StaffMember,
  StaffRole,
} from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  StaffMemberRepository,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { Kindergarten } from './domain/entities/kindergarten.entity';
import { FiscalSettingsForbiddenError } from './domain/errors/fiscal-settings-forbidden.error';
import { KindergartenNotFoundError } from './domain/errors/kindergarten-not-found.error';
import {
  KindergartenCreateInput,
  KindergartenFilters,
  KindergartenListResult,
  KindergartenRepository,
  KindergartenUpdateInput,
} from './infrastructure/persistence/kindergarten.repository';
import { KindergartenService } from './kindergarten.service';

// ── In-memory fakes ────────────────────────────────────────────────────────

class FakeKindergartenRepo extends KindergartenRepository {
  private byId = new Map<string, Kindergarten>();
  private slugs = new Set<string>();
  insertShouldThrow: Error | null = null;
  insertCalls = 0;

  put(kg: Kindergarten): void {
    this.byId.set(kg.id, kg);
    this.slugs.add(kg.slug);
  }

  create(input: KindergartenCreateInput): Promise<Kindergarten> {
    this.insertCalls += 1;
    if (this.insertShouldThrow) {
      const e = this.insertShouldThrow;
      throw e;
    }
    if (this.slugs.has(input.slug)) {
      throw new Error('slug taken');
    }
    const id = `kg-${input.slug}`;
    const now = new Date('2026-04-28T10:00:00.000Z');
    const kg = Kindergarten.hydrate({
      id,
      name: input.name,
      slug: input.slug,
      address: input.address,
      phone: input.phone,
      plan: input.plan,
      settings: input.settings,
      isActive: true,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.put(kg);
    return Promise.resolve(kg);
  }

  findById(id: string): Promise<Kindergarten | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  findBySlug(slug: string): Promise<Kindergarten | null> {
    for (const kg of this.byId.values()) {
      if (kg.slug === slug) return Promise.resolve(kg);
    }
    return Promise.resolve(null);
  }

  findAll(filters: KindergartenFilters): Promise<KindergartenListResult> {
    let items = [...this.byId.values()];
    if (filters.plan !== undefined) {
      items = items.filter((kg) => kg.plan === filters.plan);
    }
    if (filters.isActive !== undefined) {
      items = items.filter((kg) => kg.isActive === filters.isActive);
    }
    if (filters.archived === true) {
      items = items.filter((kg) => kg.isArchived);
    } else if (filters.archived === false) {
      items = items.filter((kg) => !kg.isArchived);
    }
    if (filters.nameSearch) {
      const q = filters.nameSearch.toLowerCase();
      items = items.filter((kg) => kg.name.toLowerCase().includes(q));
    }
    const total = items.length;
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    return Promise.resolve({
      items: items.slice(offset, offset + limit),
      total,
      limit,
      offset,
    });
  }

  update(id: string, changes: KindergartenUpdateInput): Promise<Kindergarten> {
    const existing = this.byId.get(id);
    if (!existing) throw new KindergartenNotFoundError(id);
    const state = existing.toState();
    const next = Kindergarten.hydrate({
      ...state,
      name: changes.name ?? state.name,
      address: changes.address !== undefined ? changes.address : state.address,
      phone: changes.phone !== undefined ? changes.phone : state.phone,
      plan: changes.plan ?? state.plan,
      settings: changes.settings ?? state.settings,
      isActive:
        changes.isActive !== undefined ? changes.isActive : state.isActive,
      archivedAt:
        changes.archivedAt !== undefined
          ? changes.archivedAt
          : state.archivedAt,
      updatedAt: new Date('2026-04-28T11:00:00.000Z'),
    });
    this.put(next);
    return Promise.resolve(next);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  rows: StaffMember[] = [];
  shouldThrowOnCreate: Error | null = null;
  deactivatedKgs: { kg: string; affected: number }[] = [];

  create(input: CreateStaffMemberInput): Promise<StaffMember> {
    if (this.shouldThrowOnCreate) {
      const e = this.shouldThrowOnCreate;
      throw e;
    }
    const sm = StaffMember.hydrate({
      id: `staff-${this.rows.length + 1}`,
      kindergartenId: input.kindergartenId,
      userId: input.userId,
      fullName: input.fullName ?? null,
      phone: input.phone ?? null,
      role: input.role,
      specialistType: input.specialistType ?? null,
      isActive: true,
      hiredAt: input.hiredAt ?? null,
      firedAt: null,
      archivedAt: null,
      createdAt: new Date('2026-04-28T10:00:00.000Z'),
      updatedAt: new Date('2026-04-28T10:00:00.000Z'),
    });
    this.rows.push(sm);
    return Promise.resolve(sm);
  }

  findById(kindergartenId: string, id: string): Promise<StaffMember | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => r.id === id && r.kindergartenId === kindergartenId,
      ) ?? null,
    );
  }

  findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(
      this.rows.find(
        (r) =>
          r.userId === userId &&
          r.kindergartenId === kindergartenId &&
          r.isActive,
      ) ?? null,
    );
  }

  listByKindergarten(kindergartenId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.kindergartenId === kindergartenId),
    );
  }

  update(): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }

  save(staffMember: StaffMember): Promise<StaffMember> {
    return Promise.resolve(staffMember);
  }

  deactivateAllByKindergarten(
    kindergartenId: string,
    now: Date,
  ): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (r.kindergartenId === kindergartenId && r.isActive) {
        r.deactivate(now);
        n += 1;
      }
    }
    this.deactivatedKgs.push({ kg: kindergartenId, affected: n });
    return Promise.resolve(n);
  }

  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.userId === userId && r.isActive),
    );
  }
}

class FakeUserRepo extends UserRepository {
  byId = new Map<string, User>();
  byPhone = new Map<string, User>();
  upsertCount = 0;
  updateCount = 0;

  put(u: User): void {
    this.byId.set(u.id, u);
    this.byPhone.set(u.phone, u);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  findByPhone(phone: string): Promise<User | null> {
    return Promise.resolve(this.byPhone.get(phone) ?? null);
  }

  upsertByPhone(phone: string): Promise<User> {
    this.upsertCount += 1;
    const existing = this.byPhone.get(phone);
    if (existing) return Promise.resolve(existing);
    const u = User.hydrate({
      id: `u-${phone}`,
      phone,
      fullName: phone,
      avatarUrl: null,
      iin: null,
      dateOfBirth: null,
      locale: 'ru',
    });
    this.put(u);
    return Promise.resolve(u);
  }

  update(id: string, changes: UserUpdateInput): Promise<User> {
    this.updateCount += 1;
    const u = this.byId.get(id);
    if (!u) throw new Error(`fake user not found: ${id}`);
    const state = u.toState();
    const updated = User.hydrate({
      ...state,
      fullName: changes.fullName ?? state.fullName,
      avatarUrl:
        changes.avatarUrl !== undefined ? changes.avatarUrl : state.avatarUrl,
      iin: changes.iin !== undefined ? changes.iin : state.iin,
      dateOfBirth:
        changes.dateOfBirth !== undefined
          ? changes.dateOfBirth
          : state.dateOfBirth,
      locale: changes.locale ?? state.locale,
    });
    this.put(updated);
    return Promise.resolve(updated);
  }
}

class FakeSms extends SmsPort {
  sent: { phone: string; message: string }[] = [];
  shouldThrow = false;

  send(phone: string, message: string): Promise<SmsSendResult> {
    if (this.shouldThrow) return Promise.reject(new Error('sms-down'));
    this.sent.push({ phone, message });
    return Promise.resolve({ txnId: `txn-${this.sent.length}` });
  }
}

class FixedClock extends ClockPort {
  constructor(private readonly date: Date) {
    super();
  }
  now(): Date {
    return this.date;
  }
}

// ── Suite ──────────────────────────────────────────────────────────────────

function buildService(
  overrides: {
    kindergartens?: FakeKindergartenRepo;
    staff?: FakeStaffRepo;
    users?: FakeUserRepo;
    sms?: FakeSms;
    clock?: ClockPort;
  } = {},
): {
  service: KindergartenService;
  kindergartens: FakeKindergartenRepo;
  staff: FakeStaffRepo;
  users: FakeUserRepo;
  sms: FakeSms;
} {
  const kindergartens = overrides.kindergartens ?? new FakeKindergartenRepo();
  const staff = overrides.staff ?? new FakeStaffRepo();
  const users = overrides.users ?? new FakeUserRepo();
  const sms = overrides.sms ?? new FakeSms();
  const clock =
    overrides.clock ?? new FixedClock(new Date('2026-04-28T12:00:00.000Z'));
  const service = new KindergartenService(
    kindergartens,
    staff,
    users,
    sms,
    clock,
  );
  return { service, kindergartens, staff, users, sms };
}

describe('KindergartenService', () => {
  describe('createKindergarten', () => {
    it('happy path inserts kg + first admin staff + sends best-effort welcome SMS', async () => {
      const { service, kindergartens, staff, users, sms } = buildService();
      const result = await service.createKindergarten({
        name: 'Солнышко',
        slug: 'solnyshko',
        admin: {
          fullName: 'Admin Alpha',
          phone: '+77011112233',
          locale: 'ru',
        },
      });
      expect(result.kindergarten.slug).toBe('solnyshko');
      expect(result.staffMember.role).toBe<StaffRole>('admin');
      expect(result.staffMember.kindergartenId).toBe(result.kindergarten.id);
      expect(result.user.phone).toBe('+77011112233');
      expect(result.user.fullName).toBe('Admin Alpha');
      expect(staff.rows).toHaveLength(1);
      expect(users.upsertCount).toBe(1);
      // SMS is fire-and-forget so we settle the microtask queue first.
      await new Promise(setImmediate);
      expect(sms.sent).toHaveLength(1);
      expect(sms.sent[0].phone).toBe('+77011112233');
      expect(kindergartens.insertCalls).toBe(1);
    });

    it('reuses pre-existing user by phone (does NOT overwrite full name)', async () => {
      const users = new FakeUserRepo();
      users.put(
        User.hydrate({
          id: 'u-existing',
          phone: '+77011112244',
          fullName: 'Pre-existing User',
          avatarUrl: null,
          iin: null,
          dateOfBirth: null,
          locale: 'kk',
        }),
      );
      const { service, staff } = buildService({ users });

      const result = await service.createKindergarten({
        name: 'Reuse Garden',
        slug: 'reuse-1',
        admin: {
          fullName: 'Will Be Ignored',
          phone: '+77011112244',
          locale: 'ru',
        },
      });
      expect(result.user.id).toBe('u-existing');
      expect(result.user.fullName).toBe('Pre-existing User');
      expect(result.user.locale).toBe('kk');
      expect(staff.rows[0].userId).toBe('u-existing');
      expect(users.updateCount).toBe(0);
    });

    it('SMS adapter failure does not roll back the create (best-effort)', async () => {
      const sms = new FakeSms();
      sms.shouldThrow = true;
      const { service, kindergartens, staff } = buildService({ sms });
      const result = await service.createKindergarten({
        name: 'No SMS Garden',
        slug: 'nosms',
        admin: { fullName: 'A', phone: '+77011112255' },
      });
      expect(result.kindergarten.slug).toBe('nosms');
      expect(staff.rows).toHaveLength(1);
      expect(kindergartens.insertCalls).toBe(1);
      // No SMS recorded but the call returned successfully.
      await new Promise(setImmediate);
      expect(sms.sent).toHaveLength(0);
    });

    it('rejects invalid slug with InvariantViolationError', async () => {
      const { service } = buildService();
      await expect(
        service.createKindergarten({
          name: 'X',
          slug: 'BAD SLUG',
          admin: { fullName: 'A', phone: '+77011110001' },
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('propagates repo errors when staff insert fails', async () => {
      const staff = new FakeStaffRepo();
      staff.shouldThrowOnCreate = new Error('boom');
      const { service } = buildService({ staff });
      await expect(
        service.createKindergarten({
          name: 'X',
          slug: 'x-1',
          admin: { fullName: 'A', phone: '+77011110002' },
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('updateSettings', () => {
    it('replaces settings on happy path', async () => {
      const { service, kindergartens } = buildService();
      const created = await service.createKindergarten({
        name: 'X',
        slug: 'x-set',
        admin: { fullName: 'A', phone: '+77011110010' },
      });
      const next = { timezone: 'Asia/Almaty', currency: 'KZT' };
      const updated = await service.updateSettings(created.kindergarten.id, {
        settings: next,
      });
      expect(updated.settings).toEqual(next);
      expect(kindergartens).toBeDefined();
    });

    it('rejects fiscal_* keys with FiscalSettingsForbiddenError when allowFiscalKeys=false', async () => {
      const { service } = buildService();
      const created = await service.createKindergarten({
        name: 'X',
        slug: 'x-fisc',
        admin: { fullName: 'A', phone: '+77011110011' },
      });
      await expect(
        service.updateSettings(created.kindergarten.id, {
          settings: { fiscal_ofd_provider: 'kassa24' },
        }),
      ).rejects.toBeInstanceOf(FiscalSettingsForbiddenError);
    });

    it('allows fiscal_* keys when allowFiscalKeys=true (SuperAdmin path)', async () => {
      const { service } = buildService();
      const created = await service.createKindergarten({
        name: 'X',
        slug: 'x-fisc-ok',
        admin: { fullName: 'A', phone: '+77011110012' },
      });
      const updated = await service.updateSettings(created.kindergarten.id, {
        settings: { fiscal_ofd_provider: 'kassa24' },
        allowFiscalKeys: true,
      });
      expect(updated.settings).toEqual({ fiscal_ofd_provider: 'kassa24' });
    });

    it('throws KindergartenNotFoundError when kg does not exist', async () => {
      const { service } = buildService();
      await expect(
        service.updateSettings('00000000-0000-0000-0000-000000000000', {
          settings: {},
        }),
      ).rejects.toBeInstanceOf(KindergartenNotFoundError);
    });
  });

  describe('listKindergartens', () => {
    it('paginates + filters by archived flag', async () => {
      const { service } = buildService();
      const created: { id: string }[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await service.createKindergarten({
          name: `KG-${i}`,
          slug: `kg-list-${i}`,
          admin: { fullName: 'A', phone: `+770111100${i}5` },
        });
        created.push({ id: r.kindergarten.id });
      }
      await service.archiveKindergarten(created[0].id);

      const activeOnly = await service.listKindergartens({ archived: false });
      expect(activeOnly.items).toHaveLength(2);
      expect(activeOnly.total).toBe(2);

      const archivedOnly = await service.listKindergartens({ archived: true });
      expect(archivedOnly.items).toHaveLength(1);
      expect(archivedOnly.items[0].id).toBe(created[0].id);

      // Pagination
      const firstPage = await service.listKindergartens({
        limit: 2,
        offset: 0,
      });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.total).toBe(3);
    });
  });

  describe('inviteAdmin', () => {
    it('happy path returns sent=true and feeds the SMS adapter', async () => {
      const { service, sms } = buildService();
      const created = await service.createKindergarten({
        name: 'Invitee Garden',
        slug: 'invitee',
        admin: { fullName: 'Pre', phone: '+77011110030' },
      });
      sms.sent.length = 0; // discard welcome SMS
      const res = await service.inviteAdmin(
        created.kindergarten.id,
        '+77011110031',
      );
      expect(res.sent).toBe(true);
      expect(res.phone).toBe('+77011110031');
      expect(sms.sent).toHaveLength(1);
    });

    it('returns sent=false when SMS adapter throws (best-effort)', async () => {
      const sms = new FakeSms();
      const { service } = buildService({ sms });
      const created = await service.createKindergarten({
        name: 'Invitee Garden',
        slug: 'invitee-2',
        admin: { fullName: 'Pre', phone: '+77011110032' },
      });
      sms.shouldThrow = true;
      const res = await service.inviteAdmin(
        created.kindergarten.id,
        '+77011110033',
      );
      expect(res.sent).toBe(false);
    });

    it('throws KindergartenNotFoundError for unknown kg', async () => {
      const { service } = buildService();
      await expect(
        service.inviteAdmin(
          '00000000-0000-0000-0000-000000000000',
          '+77011110099',
        ),
      ).rejects.toBeInstanceOf(KindergartenNotFoundError);
    });

    it('rejects invalid phone with InvariantViolationError', async () => {
      const { service } = buildService();
      const created = await service.createKindergarten({
        name: 'X',
        slug: 'x-bad-invite',
        admin: { fullName: 'A', phone: '+77011110034' },
      });
      await expect(
        service.inviteAdmin(created.kindergarten.id, 'not-a-phone'),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });
  });

  describe('archive / restore', () => {
    it('archive sets archivedAt + isActive=false + deactivates staff', async () => {
      const { service, staff } = buildService();
      const created = await service.createKindergarten({
        name: 'A',
        slug: 'a-arch',
        admin: { fullName: 'A', phone: '+77011110040' },
      });
      const archived = await service.archiveKindergarten(
        created.kindergarten.id,
      );
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.isActive).toBe(false);
      expect(staff.deactivatedKgs[0].kg).toBe(created.kindergarten.id);
      expect(staff.deactivatedKgs[0].affected).toBe(1);
    });

    it('archive is idempotent — second call is a no-op', async () => {
      const { service, staff } = buildService();
      const created = await service.createKindergarten({
        name: 'A',
        slug: 'a-arch-2',
        admin: { fullName: 'A', phone: '+77011110041' },
      });
      await service.archiveKindergarten(created.kindergarten.id);
      const second = await service.archiveKindergarten(created.kindergarten.id);
      expect(second.isArchived).toBe(true);
      // Only one cascade call recorded — second invocation short-circuits.
      expect(staff.deactivatedKgs).toHaveLength(1);
    });

    it('restore clears archivedAt + isActive=true', async () => {
      const { service } = buildService();
      const created = await service.createKindergarten({
        name: 'A',
        slug: 'a-rest',
        admin: { fullName: 'A', phone: '+77011110042' },
      });
      await service.archiveKindergarten(created.kindergarten.id);
      const restored = await service.restoreKindergarten(
        created.kindergarten.id,
      );
      expect(restored.archivedAt).toBeNull();
      expect(restored.isActive).toBe(true);
    });

    it('restore is idempotent for already-active kg', async () => {
      const { service } = buildService();
      const created = await service.createKindergarten({
        name: 'A',
        slug: 'a-rest-2',
        admin: { fullName: 'A', phone: '+77011110043' },
      });
      const restored = await service.restoreKindergarten(
        created.kindergarten.id,
      );
      expect(restored.isActive).toBe(true);
      expect(restored.isArchived).toBe(false);
    });

    it('archive throws KindergartenNotFoundError when kg missing', async () => {
      const { service } = buildService();
      await expect(
        service.archiveKindergarten('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(KindergartenNotFoundError);
    });
  });

  describe('getMyKindergarten', () => {
    it('returns the kg when present', async () => {
      const { service } = buildService();
      const created = await service.createKindergarten({
        name: 'A',
        slug: 'a-me',
        admin: { fullName: 'A', phone: '+77011110050' },
      });
      const kg = await service.getMyKindergarten(created.kindergarten.id);
      expect(kg.id).toBe(created.kindergarten.id);
    });

    it('throws KindergartenNotFoundError when kg missing', async () => {
      const { service } = buildService();
      await expect(
        service.getMyKindergarten('00000000-0000-0000-0000-000000000000'),
      ).rejects.toBeInstanceOf(KindergartenNotFoundError);
    });
  });
});
