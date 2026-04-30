import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { InvalidAttendanceTimestampError } from './domain/errors/invalid-attendance-timestamp.error';
import { InvalidTimelineEntryTypeError } from './domain/errors/invalid-timeline-entry-type.error';
import { TimelineEntryNotFoundError } from './domain/errors/timeline-entry-not-found.error';
import { TimelineEntryType } from './domain/value-objects/timeline-entry-type.vo';
import {
  ListTimelineEntriesFilter,
  PagedTimelineEntries,
  TimelineEntryRepository,
} from './infrastructure/persistence/timeline-entry.repository';

/** Entry types that are reserved for the automatic attendance flow. */
const RESERVED_ENTRY_TYPES = new Set(['check_in', 'check_out']);

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
 * Post-commit notification (createEntry only):
 *   Fire-and-forget after the ambient TX commits. Mirror of AttendanceService
 *   pattern (Promise.resolve().then(notify).catch(swallow)).
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
    @Inject(ClockPort) private readonly clock: ClockPort,
    @Inject(NotificationPort)
    private readonly notifications: NotificationPort,
  ) {}

  // ── createEntry ─────────────────────────────────────────────────────────

  async createEntry(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    dto: CreateTimelineEntryInput,
  ): Promise<TimelineEntry> {
    // Guard: reserved types only written by AttendanceService.
    if (RESERVED_ENTRY_TYPES.has(dto.entryType)) {
      throw new InvalidTimelineEntryTypeError(dto.entryType);
    }

    const staffMemberId = await this.resolveStaffMemberId(
      kindergartenId,
      callerUserId,
    );
    await this.assertChildExists(kindergartenId, childId);

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

    // Post-commit notification — fire-and-forget.
    this.fireAndForget(() =>
      this.notifications.notifyTimelineEntryCreated({
        kindergartenId,
        childId,
        entryId: entry.id,
        entryType: entry.entryType.value,
        entryTime: entry.entryTime,
        recordedByStaffMemberId: entry.recordedBy,
      }),
    );

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

    const patchedEntryTime = dto.entryTime
      ? new Date(dto.entryTime)
      : undefined;
    if (patchedEntryTime !== undefined) {
      this.assertNotFuture(patchedEntryTime);
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

    await this.timelineRepo.delete(kindergartenId, entryId);
    // No post-commit notification on delete per spec.
  }

  // ── listByChild ─────────────────────────────────────────────────────────

  async listByChild(
    kindergartenId: string,
    childId: string,
    paging: ListTimelineEntriesFilter,
  ): Promise<PagedTimelineEntries> {
    await this.assertChildExists(kindergartenId, childId);
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

  private async assertChildExists(
    kindergartenId: string,
    childId: string,
  ): Promise<void> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (child === null) {
      throw new ChildNotFoundError(childId);
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
   * Scheduled on a microtask. The dispatch may run before the TypeORM commit
   * completes; the LoggingNotificationAdapter is sync-safe today. B9 will
   * need a real post-commit hook (queryRunner.afterCommit / Outbox) before
   * WS fanout. Errors are swallowed — notifications must never break the
   * user-facing flow.
   */
  private fireAndForget(work: () => Promise<void>): void {
    Promise.resolve()
      .then(() => work())
      .catch(() => {
        /* swallow — notifications must never break the user-facing flow */
      });
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
}
