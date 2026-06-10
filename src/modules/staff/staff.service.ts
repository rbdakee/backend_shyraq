import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Locale } from '@/shared-kernel/domain/value-objects/locale.vo';
import { Phone } from '@/shared-kernel/domain/value-objects/phone.vo';
import { SmsPort } from '@/modules/auth/sms.port';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { StaffMember, StaffRole } from './domain/entities/staff-member.entity';
import { SpecialistType } from './domain/value-objects/specialist-type.vo';
import { StaffNotFoundError } from './domain/errors/staff-not-found.error';
import { StaffArchivedError } from './domain/errors/staff-archived.error';
import {
  ListStaffFilters,
  StaffMemberRepository,
} from './infrastructure/persistence/staff-member.repository';

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
 * Identity overlay for staff-list responses. `staff_members` carries its
 * own `full_name`/`phone` columns, but the kg-admin seed row created by
 * `KindergartenService.createKindergarten()` deliberately leaves them
 * null — see [`kindergarten.service.ts`](../kindergarten/kindergarten.service.ts)
 * `listAdmins()` which falls back to `users` for the same reason. Without
 * the overlay, `GET /admin/staff` returns `full_name: null, phone: null`
 * for the seed-admin row even though the user has both populated.
 */
export interface StaffIdentityOverlay {
  fullName: string | null;
  phone: string | null;
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
    // GroupRepository is provided by GroupModule. The two modules form a
    // legitimate cycle (GroupModule needs StaffMemberRepository for
    // assign-mentor pre-checks; StaffService needs GroupRepository for the
    // F10 deactivate/archive mentor cascade), so the import on GroupModule
    // is wrapped in `forwardRef` and we mirror that here.
    @Inject(forwardRef(() => GroupRepository))
    private readonly groups: GroupRepository,
    // KindergartenRepository is provided by KindergartenModule. Same
    // forwardRef pattern (KindergartenModule already imports StaffModule
    // for seeding admin staff_members on kg creation). Optional so legacy
    // spec wiring that constructs StaffService standalone (without
    // KindergartenModule) keeps passing — `create()` reads it lazily and
    // falls back to the caller-supplied `options.kindergartenName`.
    @Inject(forwardRef(() => KindergartenRepository))
    private readonly kindergartens?: KindergartenRepository,
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

  /**
   * Resolves the identity overlay for a staff row. If the row already has
   * both `full_name` and `phone` set we skip the user lookup (the common
   * case for staff created via POST /admin/staff). Only the kg-admin seed
   * row falls through to `users`, which is intentionally not tenant-scoped.
   */
  async resolveIdentity(member: StaffMember): Promise<StaffIdentityOverlay> {
    const s = member.toState();
    if (s.fullName !== null && s.phone !== null) {
      return { fullName: s.fullName, phone: s.phone };
    }
    const user = await this.users.findById(s.userId);
    const u = user?.toState() ?? null;
    return {
      fullName: s.fullName ?? u?.fullName ?? null,
      phone: s.phone ?? u?.phone ?? null,
    };
  }

  // ── create ───────────────────────────────────────────────────────────────

  /**
   * Creates a staff member: find-or-create user by phone, then insert
   * staff_members with the supplied role/specialist matrix. A best-effort
   * welcome SMS is sent post-commit; SMS failures never roll back the row.
   *
   * Looks up the kindergarten name internally for the welcome SMS template
   * — callers no longer need to inject `KindergartenRepository` (CLAUDE.md
   * §4 — controllers stay thin HTTP-edge). `options.kindergartenName`
   * remains supported as a fallback for callers that already have the
   * name in hand (e.g. KindergartenService seeding admins right after
   * create).
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

    // Resolve the kg name for the welcome SMS template. Caller-supplied
    // option wins (KindergartenService seeding already has the name);
    // otherwise look it up via the kindergartens port. We swallow any
    // lookup failure into '' so a transient kg-read blip never blocks
    // staff creation — the SMS itself is best-effort downstream.
    let kindergartenName = options?.kindergartenName ?? '';
    if (!kindergartenName && this.kindergartens) {
      try {
        const kg = await this.kindergartens.findById(kindergartenId);
        kindergartenName = kg?.name ?? '';
      } catch {
        kindergartenName = '';
      }
    }

    // Best-effort welcome SMS — never throws, never rolls back.
    void this.sendBestEffortWelcomeSms(
      kindergartenId,
      phone,
      created.id,
      kindergartenName,
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
    const now = this.clock.now();
    current.deactivate(now);
    const saved = await this.staff.save(current);
    // F10 cascade — close every active group_mentors row owned by this
    // staff member. A deactivated staff cannot continue to occupy a group's
    // unique active-mentor slot. Idempotent (returns 0 when none active).
    // Runs inside the request-scoped TX from TenantContextInterceptor, so
    // the staff update + the cascade UPDATE commit atomically.
    await this.groups.unassignMentorByStaffMember(kindergartenId, id, now);
    return saved;
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
    const now = this.clock.now();
    current.archive(now);
    const saved = await this.staff.save(current);
    // F10 cascade — archived staff is implicitly deactivated, so the same
    // mentor-row close-out applies. Idempotent (no-op when not actively
    // mentoring anywhere).
    await this.groups.unassignMentorByStaffMember(kindergartenId, id, now);
    return saved;
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
      await this.sms.sendStaffInvite(phone, kindergartenName);
    } catch (err) {
      this.logger.warn(
        `staff welcome SMS failed kg=${kindergartenId} staff=${staffId} phone=${phone}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
