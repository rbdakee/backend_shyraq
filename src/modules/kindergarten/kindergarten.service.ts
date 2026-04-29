import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Locale } from '@/shared-kernel/domain/value-objects/locale.vo';
import { Phone } from '@/shared-kernel/domain/value-objects/phone.vo';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { SmsPort } from '@/modules/auth/sms.port';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
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
import { buildAdminInviteSms, buildWelcomeSms } from './welcome-sms.templates';

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
      adminPhone.toString(),
      buildWelcomeSms(locale.toString(), kg.name, adminPhone.toString()),
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
    const message = buildAdminInviteSms('ru', kg.name);
    const sent = await this.sendBestEffortSms(
      phone,
      message,
      `admin-invite kg=${kg.id}`,
    );
    return { phone, kindergartenId: kg.id, sent };
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
    phone: string,
    message: string,
    tag: string,
  ): Promise<boolean> {
    try {
      await this.sms.send(phone, message);
      return true;
    } catch (err) {
      this.logger.warn(
        `${tag}: SMS send failed phone=${phone} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}
