import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Locale } from '@/shared-kernel/domain/value-objects/locale.vo';
import { Phone } from '@/shared-kernel/domain/value-objects/phone.vo';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { SmsPort } from '@/modules/auth/sms.port';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { AdminAlreadyExistsError } from '@/modules/staff/domain/errors/admin-already-exists.error';
import { StaffAlreadyExistsError } from '@/modules/staff/domain/errors/staff-already-exists.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import {
  Kindergarten,
  KindergartenSettings,
} from './domain/entities/kindergarten.entity';
import { FiscalSettingsForbiddenError } from './domain/errors/fiscal-settings-forbidden.error';
import { KindergartenArchivedError } from './domain/errors/kindergarten-archived.error';
import { KindergartenNotFoundError } from './domain/errors/kindergarten-not-found.error';
import { KindergartenSlug } from './domain/value-objects/kindergarten-slug.vo';
import {
  KindergartenFilters,
  KindergartenListResult,
  KindergartenRepository,
} from './infrastructure/persistence/kindergarten.repository';

export interface CreateKindergartenInput {
  name: string;
  slug: string;
  address?: string | null;
  phone?: string | null;
  plan?: string;
  settings?: KindergartenSettings;
  admin: {
    fullName: string;
    phone: string;
    locale?: string;
  };
}

export interface CreatedKindergartenWithAdmin {
  kindergarten: Kindergarten;
  user: {
    id: string;
    phone: string;
    fullName: string;
    locale: string;
  };
  staffMember: StaffMember;
}

export interface UpdateSettingsInput {
  settings: KindergartenSettings;
  /** When true (SuperAdmin path), `fiscal_*` keys are allowed. */
  allowFiscalKeys?: boolean;
}

export interface AddAdminInput {
  fullName: string;
  phone: string;
  locale?: string;
}

/**
 * One row of `GET /saas/kindergartens/:id/admins`. `fullName`/`phone`/
 * `locale` come from the linked `users` row — the kg-admin staff row is
 * created without denormalising those identity fields.
 */
export interface KindergartenAdminRow {
  staffMemberId: string;
  userId: string;
  fullName: string | null;
  phone: string | null;
  locale: string | null;
  isActive: boolean;
  hiredAt: Date | null;
  firedAt: Date | null;
  createdAt: Date;
}

export interface AddedAdmin {
  kindergartenId: string;
  user: {
    id: string;
    phone: string;
    fullName: string;
    locale: string;
  };
  staffMember: StaffMember;
  inviteSmsSent: boolean;
}

/**
 * KindergartenService — application layer for the seven P3 operations.
 *
 * Atomicity model: every public method runs inside the request-scoped
 * transaction established by `TenantContextInterceptor`. SuperAdmin
 * endpoints (`@SuperAdminScope()`) get `app.bypass_rls=true` so their
 * inserts/updates can cross tenants; KG-admin endpoints scope through
 * `app.kindergarten_id`. As a result, the service stays free of typeorm
 * imports — the repositories transparently pick up the request's
 * EntityManager from `tenantStorage`.
 */
@Injectable()
export class KindergartenService {
  private readonly logger = new Logger(KindergartenService.name);

  constructor(
    private readonly kindergartens: KindergartenRepository,
    private readonly staff: StaffMemberRepository,
    private readonly users: UserRepository,
    private readonly sms: SmsPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------- create

  /**
   * Atomic insert of kindergartens + find-or-create user-by-phone +
   * staff_members(role=admin). All three rows live in the same transaction
   * (the interceptor's). Best-effort welcome SMS afterwards — never throws.
   */
  async createKindergarten(
    input: CreateKindergartenInput,
  ): Promise<CreatedKindergartenWithAdmin> {
    const slug = KindergartenSlug.parse(input.slug);
    const adminPhone = Phone.parse(input.admin.phone);
    const kgPhone = input.phone ? Phone.parse(input.phone).toString() : null;
    const locale = input.admin.locale
      ? Locale.parse(input.admin.locale)
      : Locale.default();

    const kg = await this.kindergartens.create({
      name: input.name,
      slug: slug.toString(),
      address: input.address ?? null,
      phone: kgPhone,
      plan: input.plan ?? 'standard',
      settings: input.settings ?? {},
    });

    // Find-or-create user by phone — if a row already exists we keep its
    // full_name/locale (D10 L3 from the old plan: the SuperAdmin form does
    // NOT overwrite existing identity fields).
    let user = await this.users.findByPhone(adminPhone.toString());
    if (!user) {
      user = await this.users.upsertByPhone(adminPhone.toString());
      // Patch the freshly created user with the supplied full name / locale.
      user = await this.users.update(user.id, {
        fullName: input.admin.fullName,
        locale: locale.toString(),
      });
    }

    const staff = await this.staff.create({
      kindergartenId: kg.id,
      userId: user.id,
      role: 'admin',
      hiredAt: this.clock.now(),
    });

    // Best-effort welcome SMS — never rolls back, never throws.
    void this.sendBestEffortSms(
      () => this.sms.sendAdminInvite(adminPhone.toString(), kg.name),
      `welcome kg=${kg.id}`,
    );

    const userState = user.toState();
    return {
      kindergarten: kg,
      user: {
        id: userState.id,
        phone: userState.phone,
        fullName: userState.fullName,
        locale: userState.locale,
      },
      staffMember: staff,
    };
  }

  // ---------------------------------------------------------- update / read

  async updateSettings(
    kindergartenId: string,
    input: UpdateSettingsInput,
  ): Promise<Kindergarten> {
    if (!input.allowFiscalKeys) {
      for (const key of Object.keys(input.settings)) {
        if (key.startsWith('fiscal_')) {
          throw new FiscalSettingsForbiddenError();
        }
      }
    }
    const existing = await this.kindergartens.findById(kindergartenId);
    if (!existing) throw new KindergartenNotFoundError(kindergartenId);
    if (existing.isArchived)
      throw new KindergartenArchivedError(kindergartenId);
    return this.kindergartens.update(kindergartenId, {
      settings: input.settings,
    });
  }

  async getMyKindergarten(kindergartenId: string): Promise<Kindergarten> {
    const kg = await this.kindergartens.findById(kindergartenId);
    if (!kg) throw new KindergartenNotFoundError(kindergartenId);
    return kg;
  }

  async listKindergartens(
    filters: KindergartenFilters,
  ): Promise<KindergartenListResult> {
    return this.kindergartens.findAll(filters);
  }

  // -------------------------------------------------------------- invite

  /**
   * Best-effort admin-invite SMS. Verifies the kindergarten exists and is
   * not archived, then sends an SMS describing the invite. Never throws on
   * SMS adapter failures — surfaces only kindergarten-not-found / archived.
   */
  async inviteAdmin(
    kindergartenId: string,
    rawPhone: string,
  ): Promise<{ phone: string; kindergartenId: string; sent: boolean }> {
    const kg = await this.kindergartens.findById(kindergartenId);
    if (!kg) throw new KindergartenNotFoundError(kindergartenId);
    if (kg.isArchived) throw new KindergartenArchivedError(kindergartenId);

    const phone = Phone.parse(rawPhone).toString();
    const sent = await this.sendBestEffortSms(
      () => this.sms.sendAdminInvite(phone, kg.name),
      `admin-invite kg=${kg.id}`,
    );
    return { phone, kindergartenId: kg.id, sent };
  }

  // ------------------------------------------------------------ admins

  /**
   * Lists admins (`staff_members.role='admin'`) of a kindergarten. Optional
   * `isActive` filter; omitted → both active and deactivated admins. The
   * staff row created via the kg-admin flow does not denormalise
   * full_name/phone/locale, so those are resolved from the linked `users`.
   */
  async listAdmins(
    kindergartenId: string,
    isActive?: boolean,
  ): Promise<KindergartenAdminRow[]> {
    const kg = await this.kindergartens.findById(kindergartenId);
    if (!kg) throw new KindergartenNotFoundError(kindergartenId);

    const members = await this.staff.listByKindergarten(kindergartenId, {
      role: 'admin',
      isActive,
    });

    const rows: KindergartenAdminRow[] = [];
    for (const m of members) {
      const s = m.toState();
      const user = await this.users.findById(s.userId);
      const u = user?.toState() ?? null;
      rows.push({
        staffMemberId: s.id,
        userId: s.userId,
        // Prefer the canonical users identity; fall back to the staff row's
        // denormalised columns when present (e.g. seeded via /admin/staff).
        fullName: u?.fullName ?? s.fullName,
        phone: u?.phone ?? s.phone,
        locale: u?.locale ?? null,
        isActive: s.isActive,
        hiredAt: s.hiredAt,
        firedAt: s.firedAt,
        createdAt: s.createdAt,
      });
    }
    return rows;
  }

  /**
   * Adds another admin to an existing kindergarten. Find-or-create user by
   * phone (existing identity untouched), strict-409 conflict check against
   * ANY staff row for the pair (active or not), then a staff_members row
   * with role=admin. Best-effort invite SMS afterwards — never throws.
   */
  async addAdmin(
    kindergartenId: string,
    input: AddAdminInput,
  ): Promise<AddedAdmin> {
    const kg = await this.kindergartens.findById(kindergartenId);
    if (!kg) throw new KindergartenNotFoundError(kindergartenId);
    if (kg.isArchived) throw new KindergartenArchivedError(kindergartenId);

    const adminPhone = Phone.parse(input.phone);
    const locale = input.locale ? Locale.parse(input.locale) : Locale.default();

    // Find-or-create user by phone — existing identity is NOT overwritten;
    // only a freshly created user gets the supplied full name / locale.
    let user = await this.users.findByPhone(adminPhone.toString());
    if (!user) {
      user = await this.users.upsertByPhone(adminPhone.toString());
      user = await this.users.update(user.id, {
        fullName: input.fullName,
        locale: locale.toString(),
      });
    }

    // Strict conflict — any existing staff row for the pair blocks the add,
    // regardless of is_active (an inactive admin would resurrect via the
    // partial unique index path).
    const existing = await this.staff.findByUserAndKindergarten(user.id, kg.id);
    if (existing) {
      if (existing.role === 'admin') {
        throw new AdminAlreadyExistsError(kg.id, user.id);
      }
      throw new StaffAlreadyExistsError(kg.id, user.id);
    }

    let staff: StaffMember;
    try {
      staff = await this.staff.create({
        kindergartenId: kg.id,
        userId: user.id,
        role: 'admin',
        hiredAt: this.clock.now(),
      });
    } catch (err) {
      // Concurrency: a racing request inserted a conflicting row between the
      // pre-insert check above and create(). The partial unique index fires
      // 23505, which the relational repo always maps to
      // StaffAlreadyExistsError (shared mapping used by other callers). Re-read
      // the now-existing row so the losing request returns the correct
      // contract code when the conflicting row is an admin.
      if (err instanceof StaffAlreadyExistsError) {
        const racedRow = await this.staff.findByUserAndKindergarten(
          user.id,
          kg.id,
        );
        if (racedRow?.role === 'admin') {
          throw new AdminAlreadyExistsError(kg.id, user.id);
        }
      }
      throw err;
    }

    const inviteSmsSent = await this.sendBestEffortSms(
      () => this.sms.sendAdminInvite(adminPhone.toString(), kg.name),
      `admin-add kg=${kg.id}`,
    );

    const userState = user.toState();
    return {
      kindergartenId: kg.id,
      user: {
        id: userState.id,
        phone: userState.phone,
        fullName: userState.fullName,
        locale: userState.locale,
      },
      staffMember: staff,
      inviteSmsSent,
    };
  }

  // ----------------------------------------------------------- archive / restore

  async archiveKindergarten(kindergartenId: string): Promise<Kindergarten> {
    const existing = await this.kindergartens.findById(kindergartenId);
    if (!existing) throw new KindergartenNotFoundError(kindergartenId);
    if (existing.isArchived) {
      // Idempotent — return the row unchanged. Old behavior + simpler clients.
      return existing;
    }
    const now = this.clock.now();
    const updated = await this.kindergartens.update(kindergartenId, {
      isActive: false,
      archivedAt: now,
    });
    // Cascade: deactivate every staff_members row for this kg.
    await this.staff.deactivateAllByKindergarten(kindergartenId, now);
    return updated;
  }

  async restoreKindergarten(kindergartenId: string): Promise<Kindergarten> {
    const existing = await this.kindergartens.findById(kindergartenId);
    if (!existing) throw new KindergartenNotFoundError(kindergartenId);
    if (!existing.isArchived) {
      // Idempotent — already restored.
      return existing;
    }
    return this.kindergartens.update(kindergartenId, {
      isActive: true,
      archivedAt: null,
    });
  }

  // ----------------------------------------------------------------- private

  private async sendBestEffortSms(
    send: () => Promise<unknown>,
    tag: string,
  ): Promise<boolean> {
    try {
      await send();
      return true;
    } catch (err) {
      this.logger.warn(
        `${tag}: SMS send failed err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}
