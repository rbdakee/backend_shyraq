import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Locale } from '@/shared-kernel/domain/value-objects/locale.vo';
import { Phone } from '@/shared-kernel/domain/value-objects/phone.vo';
import { SmsPort } from '@/modules/auth/sms.port';
import { UserRepository } from '@/modules/users/user.repository';
import { StaffMember, StaffRole } from './domain/entities/staff-member.entity';
import { SpecialistType } from './domain/value-objects/specialist-type.vo';
import { StaffNotFoundError } from './domain/errors/staff-not-found.error';
import { StaffArchivedError } from './domain/errors/staff-archived.error';
import {
  ListStaffFilters,
  StaffMemberRepository,
} from './staff-member.repository';
import { buildStaffWelcomeSms } from './application/staff-welcome-sms.templates';

export interface CreateStaffInput {
  fullName: string;
  phone: string;
  role: StaffRole;
  specialistType?: SpecialistType | null;
  hiredAt?: Date | null;
}

export interface UpdateStaffInput {
  fullName?: string;
  role?: StaffRole;
  specialistType?: SpecialistType | null;
  hiredAt?: Date | null;
  firedAt?: Date | null;
}

/**
 * StaffService — application layer for the P4 admin/staff CRUD surface.
 *
 * Atomicity model: every public method runs inside the request-scoped
 * transaction set up by `TenantContextInterceptor`. The repositories
 * transparently pick up the request's EntityManager from `tenantStorage`,
 * so the service stays free of typeorm imports.
 *
 * Each method explicitly threads `kindergartenId` into repo calls — RLS in
 * the DB is the second line of defense; explicit scoping keeps the service
 * code readable and IDE-navigable.
 */
@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly staff: StaffMemberRepository,
    private readonly users: UserRepository,
    private readonly sms: SmsPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async list(
    kindergartenId: string,
    filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return this.staff.listByKindergarten(kindergartenId, filters);
  }

  async getById(kindergartenId: string, id: string): Promise<StaffMember> {
    const row = await this.staff.findById(kindergartenId, id);
    if (!row) throw new StaffNotFoundError(id);
    return row;
  }

  // ── create ───────────────────────────────────────────────────────────────

  /**
   * Creates a staff member: find-or-create user by phone, then insert
   * staff_members with the supplied role/specialist matrix. A best-effort
   * welcome SMS is sent post-commit; SMS failures never roll back the row.
   */
  async create(
    kindergartenId: string,
    input: CreateStaffInput,
    options?: { kindergartenName?: string },
  ): Promise<StaffMember> {
    const phone = Phone.parse(input.phone).toString();
    StaffMember.validateRoleMatrix(input.role, input.specialistType ?? null);

    // Find-or-create user. Existing user's full_name/locale are NOT
    // overwritten — staff_members carries its own full_name copy now.
    let user = await this.users.findByPhone(phone);
    if (!user) {
      user = await this.users.upsertByPhone(phone);
      user = await this.users.update(user.id, {
        fullName: input.fullName,
        locale: Locale.default().toString(),
      });
    }

    const created = await this.staff.create({
      kindergartenId,
      userId: user.id,
      fullName: input.fullName,
      phone,
      role: input.role,
      specialistType: input.specialistType ?? null,
      hiredAt: input.hiredAt ?? this.clock.now(),
    });

    // Best-effort welcome SMS — never throws, never rolls back.
    void this.sendBestEffortWelcomeSms(
      kindergartenId,
      phone,
      created.id,
      options?.kindergartenName ?? '',
    );

    return created;
  }

  // ── update ───────────────────────────────────────────────────────────────

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateStaffInput,
  ): Promise<StaffMember> {
    const current = await this.staff.findById(kindergartenId, id);
    if (!current) throw new StaffNotFoundError(id);
    if (current.isArchived) throw new StaffArchivedError(id);

    // Validate the merged role × specialist_type matrix up-front so we
    // reject impossible combos before touching the DB.
    const mergedRole = patch.role ?? current.role;
    const mergedSpecialist =
      patch.specialistType !== undefined
        ? patch.specialistType
        : current.specialistType;
    StaffMember.validateRoleMatrix(mergedRole, mergedSpecialist);

    const updated = await this.staff.update(kindergartenId, id, patch);
    if (!updated) throw new StaffNotFoundError(id);
    return updated;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async deactivate(kindergartenId: string, id: string): Promise<StaffMember> {
    const current = await this.staff.findById(kindergartenId, id);
    if (!current) throw new StaffNotFoundError(id);
    if (current.isArchived) throw new StaffArchivedError(id);
    if (!current.isActive) return current; // idempotent
    current.deactivate(this.clock.now());
    return this.staff.save(current);
  }

  async activate(kindergartenId: string, id: string): Promise<StaffMember> {
    const current = await this.staff.findById(kindergartenId, id);
    if (!current) throw new StaffNotFoundError(id);
    if (current.isArchived) throw new StaffArchivedError(id);
    if (current.isActive) return current; // idempotent
    current.activate(this.clock.now());
    return this.staff.save(current);
  }

  async archive(kindergartenId: string, id: string): Promise<StaffMember> {
    const current = await this.staff.findById(kindergartenId, id);
    if (!current) throw new StaffNotFoundError(id);
    if (current.isArchived) return current; // idempotent
    current.archive(this.clock.now());
    return this.staff.save(current);
  }

  async restore(kindergartenId: string, id: string): Promise<StaffMember> {
    const current = await this.staff.findById(kindergartenId, id);
    if (!current) throw new StaffNotFoundError(id);
    if (!current.isArchived) return current; // idempotent
    current.restore(this.clock.now());
    return this.staff.save(current);
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async sendBestEffortWelcomeSms(
    kindergartenId: string,
    phone: string,
    staffId: string,
    kindergartenName: string,
  ): Promise<void> {
    try {
      const message = buildStaffWelcomeSms(
        Locale.default().toString(),
        kindergartenName,
        phone,
      );
      await this.sms.send(phone, message);
    } catch (err) {
      this.logger.warn(
        `staff welcome SMS failed kg=${kindergartenId} staff=${staffId} phone=${phone}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
