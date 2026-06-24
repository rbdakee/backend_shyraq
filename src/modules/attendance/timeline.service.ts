import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffService } from '@/modules/staff/staff.service';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { InvalidAttendanceTimestampError } from './domain/errors/invalid-attendance-timestamp.error';
import { InvalidTimelineEntryTypeError } from './domain/errors/invalid-timeline-entry-type.error';
import { InvalidTimelineMetadataError } from './domain/errors/invalid-timeline-metadata.error';
import { MentorScopeViolatedError } from './domain/errors/mentor-scope-violated.error';
import { TimelineEntryNotFoundError } from './domain/errors/timeline-entry-not-found.error';
import { TimelineEntryType } from './domain/value-objects/timeline-entry-type.vo';
import {
  ListTimelineEntriesFilter,
  PagedTimelineEntries,
  TimelineEntryRepository,
} from './infrastructure/persistence/timeline-entry.repository';

/** Entry types that are reserved for the automatic attendance flow. */
const RESERVED_ENTRY_TYPES = new Set(['check_in', 'check_out']);

/** Returns the trimmed value, or null when empty/whitespace-only/absent. */
function nonBlankOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface CreateTimelineEntryInput {
  entryType: string;
  title?: string | null;
  body?: string | null;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
  entryTime?: string;
}

export interface UpdateTimelineEntryInput {
  title?: string | null;
  body?: string | null;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
  entryTime?: string;
}

export interface TimelineEntryOpts {
  isAdmin: boolean;
  /** Role of the caller — used to enforce mentor-group scope. */
  callerRole?: string;
}

/**
 * TimelineService — standalone CRUD for timeline_entries rows authored by
 * staff via T4's /staff/timeline-entries/* endpoints.
 *
 * Single-service pattern per CLAUDE.md §8. No use-case classes.
 *
 * Author-check contract:
 *   - updateEntry / deleteEntry: non-admin callers must be the author
 *     (`recorded_by = callerStaffMemberId`). Admins bypass. Enforced via
 *     `TimelineEntry.assertEditableBy()`.
 *
 * Mentor-group scope contract (B22b T13):
 *   - createEntry / updateEntry / deleteEntry: when the caller has
 *     `role=mentor`, the child must belong to a group the mentor is
 *     currently actively assigned to (`group_mentors.unassigned_at IS NULL`
 *     + `staff_member_id` matches the caller). Throws
 *     `MentorScopeViolatedError` (403) when violated. Admin callers
 *     (opts.isAdmin=true) and other roles (specialist, reception) bypass.
 *
 * Outbox notification (createEntry only):
 *   Awaited inside the ambient TX so the outbox row is committed atomically
 *   with the timeline row. OutboxNotificationAdapter uses the request-level
 *   EntityManager from tenantStorage.
 *
 * Ambient TX:
 *   Service does NOT open its own `dataSource.transaction()` — relies on the
 *   TenantContextInterceptor ambient transaction. All repo calls within one
 *   request participate in the same TX automatically.
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly timelineRepo: TimelineEntryRepository,
    private readonly childRepo: ChildRepository,
    private readonly staffRepo: StaffMemberRepository,
    private readonly groupRepo: GroupRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @Inject(NotificationPort)
    private readonly notifications: NotificationPort,
    // Identity-overlay dep. Optional + appended last so the existing
    // service-unit wiring (positional `new TimelineService(...)`) keeps
    // compiling. `resolveRecordedByNames` reuses the staff identity fallback
    // (`staff_members.full_name ?? users.full_name`); fails closed → null
    // when undefined.
    @Optional()
    private readonly staffService?: StaffService,
  ) {}

  // ── identity overlay ──────────────────────────────────────────────────────

  /**
   * Identity overlay for timeline lists — resolves each entry's
   * `recorded_by` (a `staff_members.id`) to a display name via the staff
   * identity fallback (`staff_members.full_name ?? users.full_name`, reusing
   * `StaffService.resolveIdentity`). Mirrors
   * `ProgressNoteService.resolveMentorNames`: distinct ids are looked up once
   * and returned as a map keyed by `recorded_by`.
   *
   * Blank/whitespace-only names collapse to null. Fails closed: if the staff
   * service is not wired (legacy spec construction) or a staff row is
   * missing, that entry resolves to null.
   */
  async resolveRecordedByNames(
    kindergartenId: string,
    entries: { recordedBy: string | null }[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.staffService) {
      return out;
    }
    const distinctIds = [
      ...new Set(
        entries
          .map((e) => e.recordedBy)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    for (const staffMemberId of distinctIds) {
      const member = await this.staffRepo.findById(
        kindergartenId,
        staffMemberId,
      );
      if (!member) {
        out.set(staffMemberId, null);
        continue;
      }
      const identity = await this.staffService.resolveIdentity(member);
      out.set(staffMemberId, nonBlankOrNull(identity.fullName));
    }
    return out;
  }

  // ── createEntry ─────────────────────────────────────────────────────────

  async createEntry(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    dto: CreateTimelineEntryInput,
    opts: TimelineEntryOpts = { isAdmin: false },
  ): Promise<TimelineEntry> {
    // Guard: reserved types only written by AttendanceService.
    if (RESERVED_ENTRY_TYPES.has(dto.entryType)) {
      throw new InvalidTimelineEntryTypeError(dto.entryType);
    }

    // BR-013: mood/meal metadata shape validation (422 if the typed key is
    // present but out of range). Runs before any DB work so invalid input
    // never opens the TX path.
    this.assertTimelineMetadata(dto.entryType, dto.metadata);

    const staffMemberId = await this.resolveStaffMemberId(
      kindergartenId,
      callerUserId,
    );
    const child = await this.findChildOrThrow(kindergartenId, childId);

    // Mentor-group scope: a mentor may only write entries for children in
    // their actively-assigned group. Admin callers bypass. Other roles
    // (specialist, reception) also bypass — they are kg-scoped, not
    // group-scoped.
    if (!opts.isAdmin && opts.callerRole === 'mentor') {
      await this.assertMentorScopeForChild(
        kindergartenId,
        callerUserId,
        child.currentGroupId ?? null,
        childId,
      );
    }

    const entryTime = dto.entryTime
      ? new Date(dto.entryTime)
      : this.clock.now();
    this.assertNotFuture(entryTime);

    const entry = await this.timelineRepo.create(
      kindergartenId,
      TimelineEntry.createNew(
        {
          id: randomUUID(),
          kindergartenId,
          childId,
          entryType: TimelineEntryType.from(dto.entryType),
          title: dto.title ?? null,
          body: dto.body ?? null,
          mediaUrls: dto.mediaUrls ?? null,
          metadata: dto.metadata ?? null,
          recordedBy: staffMemberId,
          entryTime,
        },
        this.clock,
      ),
    );

    // Outbox notification — atomic with the timeline write (same TX).
    await this.notifications.notifyTimelineEntryCreated({
      kindergartenId,
      childId,
      entryId: entry.id,
      entryType: entry.entryType.value,
      entryTime: entry.entryTime,
      recordedByStaffMemberId: entry.recordedBy,
    });

    return entry;
  }

  // ── updateEntry ─────────────────────────────────────────────────────────

  async updateEntry(
    kindergartenId: string,
    entryId: string,
    callerUserId: string,
    dto: UpdateTimelineEntryInput,
    opts: TimelineEntryOpts,
  ): Promise<TimelineEntry> {
    const entry = await this.findEntryOrThrow(kindergartenId, entryId);

    const staffMemberId = opts.isAdmin
      ? null
      : await this.resolveStaffMemberId(kindergartenId, callerUserId);

    // Throws TimelineEntryNotAuthorError (403) when non-admin non-author.
    entry.assertEditableBy(staffMemberId, opts.isAdmin);

    // Mentor-group scope: verify the mentor is assigned to the child's group.
    if (!opts.isAdmin && opts.callerRole === 'mentor') {
      const child = await this.findChildOrThrow(kindergartenId, entry.childId);
      await this.assertMentorScopeForChild(
        kindergartenId,
        callerUserId,
        child.currentGroupId ?? null,
        entry.childId,
      );
    }

    const patchedEntryTime = dto.entryTime
      ? new Date(dto.entryTime)
      : undefined;
    if (patchedEntryTime !== undefined) {
      this.assertNotFuture(patchedEntryTime);
    }

    // BR-013: validate the patched metadata against the (immutable) entry_type.
    // entry_type cannot change on update, so we read it off the loaded entry.
    // Only validate when metadata is part of the patch (undefined = untouched).
    if (dto.metadata !== undefined) {
      this.assertTimelineMetadata(entry.entryType.value, dto.metadata);
    }

    entry.applyPatch({
      title: dto.title,
      body: dto.body,
      mediaUrls: dto.mediaUrls,
      metadata: dto.metadata,
      entryTime: patchedEntryTime,
    });

    return this.timelineRepo.update(kindergartenId, entry);
    // No post-commit notification on update (silent edit per spec).
  }

  // ── deleteEntry ─────────────────────────────────────────────────────────

  async deleteEntry(
    kindergartenId: string,
    entryId: string,
    callerUserId: string,
    opts: TimelineEntryOpts,
  ): Promise<void> {
    const entry = await this.findEntryOrThrow(kindergartenId, entryId);

    const staffMemberId = opts.isAdmin
      ? null
      : await this.resolveStaffMemberId(kindergartenId, callerUserId);

    // Throws TimelineEntryNotAuthorError (403) when non-admin non-author.
    entry.assertEditableBy(staffMemberId, opts.isAdmin);

    // Mentor-group scope: verify the mentor is assigned to the child's group.
    if (!opts.isAdmin && opts.callerRole === 'mentor') {
      const child = await this.findChildOrThrow(kindergartenId, entry.childId);
      await this.assertMentorScopeForChild(
        kindergartenId,
        callerUserId,
        child.currentGroupId ?? null,
        entry.childId,
      );
    }

    await this.timelineRepo.delete(kindergartenId, entryId);
    // No post-commit notification on delete per spec.
  }

  // ── listByChild ─────────────────────────────────────────────────────────

  async listByChild(
    kindergartenId: string,
    childId: string,
    paging: ListTimelineEntriesFilter,
  ): Promise<PagedTimelineEntries> {
    await this.findChildOrThrow(kindergartenId, childId);
    return this.timelineRepo.findByChild(kindergartenId, childId, paging);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async resolveStaffMemberId(
    kindergartenId: string,
    callerUserId: string,
  ): Promise<string> {
    const staff = await this.staffRepo.findActiveByUserAndKindergarten(
      callerUserId,
      kindergartenId,
    );
    if (!staff) throw new StaffNotFoundError(callerUserId);
    return staff.id;
  }

  private async findChildOrThrow(kindergartenId: string, childId: string) {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (child === null) {
      throw new ChildNotFoundError(childId);
    }
    return child;
  }

  /**
   * Asserts that the caller (by userId) is the active mentor for the group
   * the given child belongs to. Throws `MentorScopeViolatedError` (403) if:
   *   - the child has no `current_group_id` (unassigned), or
   *   - the caller is not the active mentor of that group.
   *
   * Uses `GroupRepository.isUserActiveMentorForGroup` which joins
   * `group_mentors` ↔ `staff_members` on `staff_member_id` and filters
   * by `user_id` + `unassigned_at IS NULL`.
   */
  private async assertMentorScopeForChild(
    kindergartenId: string,
    callerUserId: string,
    currentGroupId: string | null,
    childId: string,
  ): Promise<void> {
    if (!currentGroupId) {
      // Child has no group — mentor cannot claim scope for an unassigned child.
      throw new MentorScopeViolatedError(childId);
    }
    const isMentor = await this.groupRepo.isUserActiveMentorForGroup(
      kindergartenId,
      callerUserId,
      currentGroupId,
    );
    if (!isMentor) {
      throw new MentorScopeViolatedError(childId);
    }
  }

  private async findEntryOrThrow(
    kindergartenId: string,
    entryId: string,
  ): Promise<TimelineEntry> {
    const entry = await this.timelineRepo.findById(kindergartenId, entryId);
    if (entry === null) {
      throw new TimelineEntryNotFoundError(entryId);
    }
    return entry;
  }

  /**
   * Reject `entry_time` values more than 5 minutes in the future. Same
   * skew tolerance as AttendanceService.assertNotFuture. Throws
   * InvalidAttendanceTimestampError → 422 (T6 M3 fix-pass).
   */
  private assertNotFuture(when: Date): void {
    const now = this.clock.now();
    const SKEW_MS = 5 * 60 * 1000;
    if (when.getTime() > now.getTime() + SKEW_MS) {
      throw new InvalidAttendanceTimestampError(when, now);
    }
  }

  /**
   * BR-013 — server-side validation of the adaptive `metadata` shape.
   *
   * Contract (mirrors local_docs/mobile_staff/BACKEND_RESPONSE_013):
   *   - entry_type='mood' → if `metadata.mood` is present it must be one of
   *     `happy | ok | sad`.
   *   - entry_type='meal' → if `metadata.ate` is present it must be one of
   *     `all | half | little`.
   * `metadata` stays optional — null/undefined passes, the typed key may be
   * absent, and extra keys are ignored. All other entry_types skip validation.
   * Invalid values throw `InvalidTimelineMetadataError` → 422.
   */
  private assertTimelineMetadata(
    entryType: string,
    metadata: Record<string, unknown> | null | undefined,
  ): void {
    if (metadata == null) return;
    if (entryType === 'mood') {
      const v = metadata['mood'];
      if (v !== undefined && !['happy', 'ok', 'sad'].includes(v as string)) {
        throw new InvalidTimelineMetadataError(
          'mood',
          `mood must be happy|ok|sad, got ${String(v)}`,
        );
      }
    }
    if (entryType === 'meal') {
      const v = metadata['ate'];
      if (v !== undefined && !['all', 'half', 'little'].includes(v as string)) {
        throw new InvalidTimelineMetadataError(
          'meal',
          `ate must be all|half|little, got ${String(v)}`,
        );
      }
    }
  }
}
