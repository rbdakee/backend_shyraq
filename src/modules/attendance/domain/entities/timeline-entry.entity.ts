import {
  TimelineEntryType,
  TimelineEntryTypeValue,
} from '../value-objects/timeline-entry-type.vo';
import { TimelineEntryNotAuthorError } from '../errors/timeline-entry-not-author.error';

export interface Clock {
  now(): Date;
}

export interface TimelineEntryState {
  id: string;
  kindergartenId: string;
  childId: string;
  entryType: TimelineEntryTypeValue;
  title: string | null;
  body: string | null;
  mediaUrls: string[] | null;
  metadata: Record<string, unknown> | null;
  recordedBy: string | null;
  entryTime: Date;
  createdAt: Date;
  sourceEventId: string | null;
}

export interface CreateTimelineEntryInput {
  id: string;
  kindergartenId: string;
  childId: string;
  entryType: TimelineEntryType;
  title?: string | null;
  body?: string | null;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
  recordedBy: string | null;
  entryTime: Date;
  /**
   * The `attendance_events` row this entry mirrors, for check_in / check_out
   * entries written in the same transaction as the event. null for
   * standalone entries (activity, meal, note, …).
   *
   * Without this link the pair could only be matched heuristically on
   * (child_id, entry_type, entry_time), which is not safe to cascade a
   * delete or a child re-point through.
   */
  sourceEventId?: string | null;
}

/**
 * TimelineEntry — append-friendly journal row written by staff actions.
 *
 * In T3 only `check_in` / `check_out` rows are produced (mirroring the
 * AttendanceEvent created in the same transaction). Other entry types are
 * the responsibility of T4's standalone timeline endpoints.
 *
 * The entity stays small intentionally: full edit/delete semantics live in
 * T4's TimelineService.
 */
export class TimelineEntry {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    private _childId: string,
    readonly entryType: TimelineEntryType,
    private _title: string | null,
    private _body: string | null,
    private _mediaUrls: string[] | null,
    private _metadata: Record<string, unknown> | null,
    readonly recordedBy: string | null,
    private _entryTime: Date,
    readonly createdAt: Date,
    readonly sourceEventId: string | null,
  ) {}

  static createNew(
    input: CreateTimelineEntryInput,
    clock: Clock,
  ): TimelineEntry {
    return new TimelineEntry(
      input.id,
      input.kindergartenId,
      input.childId,
      input.entryType,
      input.title ?? null,
      input.body ?? null,
      input.mediaUrls ?? null,
      input.metadata ?? null,
      input.recordedBy,
      input.entryTime,
      clock.now(),
      input.sourceEventId ?? null,
    );
  }

  static hydrate(state: TimelineEntryState): TimelineEntry {
    return new TimelineEntry(
      state.id,
      state.kindergartenId,
      state.childId,
      TimelineEntryType.from(state.entryType),
      state.title,
      state.body,
      state.mediaUrls,
      state.metadata,
      state.recordedBy,
      state.entryTime,
      state.createdAt,
      state.sourceEventId,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get childId(): string {
    return this._childId;
  }

  get title(): string | null {
    return this._title;
  }
  get body(): string | null {
    return this._body;
  }
  get mediaUrls(): string[] | null {
    return this._mediaUrls;
  }
  get metadata(): Record<string, unknown> | null {
    return this._metadata;
  }
  get entryTime(): Date {
    return this._entryTime;
  }

  /**
   * Edit-permission check used by T4's TimelineService.updateEntry. Author of
   * the row may edit; admins bypass via the `isAdmin` flag (passed by the
   * controller from JWT claims). T3 does not call this — it is here to keep
   * the entity self-contained for T4 wiring.
   */
  assertEditableBy(staffMemberId: string | null, isAdmin: boolean): void {
    if (isAdmin) return;
    if (this.recordedBy === null || staffMemberId === null) {
      throw new TimelineEntryNotAuthorError(this.id);
    }
    if (this.recordedBy !== staffMemberId) {
      throw new TimelineEntryNotAuthorError(this.id);
    }
  }

  /**
   * Apply a partial update to mutable fields (title / body / mediaUrls /
   * metadata / entryTime / childId). entry_type is intentionally excluded —
   * changing the type of an existing entry is not allowed.
   *
   * `childId` is not reachable from the staff timeline endpoints; it exists
   * for the admin attendance cascade, which re-points a check_in / check_out
   * entry when its source event is corrected onto another child.
   */
  applyPatch(patch: {
    title?: string | null;
    body?: string | null;
    mediaUrls?: string[] | null;
    metadata?: Record<string, unknown> | null;
    entryTime?: Date;
    childId?: string;
  }): void {
    if (patch.title !== undefined) this._title = patch.title;
    if (patch.body !== undefined) this._body = patch.body;
    if (patch.mediaUrls !== undefined) this._mediaUrls = patch.mediaUrls;
    if (patch.metadata !== undefined) this._metadata = patch.metadata;
    if (patch.entryTime !== undefined) this._entryTime = patch.entryTime;
    if (patch.childId !== undefined) this._childId = patch.childId;
  }

  toState(): TimelineEntryState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this._childId,
      entryType: this.entryType.value,
      title: this._title,
      body: this._body,
      mediaUrls: this._mediaUrls,
      metadata: this._metadata,
      recordedBy: this.recordedBy,
      entryTime: this._entryTime,
      createdAt: this.createdAt,
      sourceEventId: this.sourceEventId,
    };
  }
}
