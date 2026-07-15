/**
 * Kinds of entity the audit trail can describe. Kept as a plain string union
 * rather than a VO: the DB column carries NO check constraint on `entity_type`
 * (see the AdminAttendanceAudit migration) precisely so future modules can log
 * their own entities without a migration. Widen this union when they do.
 */
export type AuditEntityType = 'attendance_event' | 'child_daily_status';

/** Mirrors the `audit_log_action_chk` CHECK constraint. */
export type AuditAction = 'create' | 'update' | 'delete';

export const AUDIT_ACTION_VALUES: readonly AuditAction[] = [
  'create',
  'update',
  'delete',
];

/**
 * Free-form snapshot of a row, as persisted in the `before` / `after` jsonb
 * columns. Shape is owned by the calling module, not by audit.
 */
export type AuditSnapshot = Record<string, unknown>;

/**
 * Widens a caller's own state type into `AuditSnapshot`.
 *
 * Needed because TypeScript gives `interface` declarations no implicit index
 * signature, so a perfectly compatible `AttendanceEventState` is still not
 * assignable to `Record<string, unknown>`. Rather than widen `AuditSnapshot`
 * to `object` (which would let anything through) or repeat a cast at every
 * call site, the unsoundness is contained here, in one place, behind a
 * signature that only accepts objects.
 *
 * Note the values are stored as jsonb: `Date` fields land as ISO strings, so
 * a snapshot read back is not `===` to the state that produced it.
 */
export function toAuditSnapshot<T extends object>(state: T): AuditSnapshot {
  return { ...state } as unknown as AuditSnapshot;
}

export interface AuditLogEntryState {
  id: string;
  kindergartenId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actorUserId: string | null;
  actorStaffId: string | null;
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
  createdAt: Date;
}

export interface CreateAuditLogEntryInput {
  id: string;
  kindergartenId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actorUserId?: string | null;
  actorStaffId?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  createdAt: Date;
}

/**
 * AuditLogEntry — one immutable record of a mutation to a tenant-scoped row.
 *
 * CRUD-only by design: the trail is append-only, so there is no state machine
 * and no patch surface. Every field is `readonly` — an audit row that can be
 * edited after the fact is not an audit row. Both actor ids are independently
 * nullable: staff-driven mutations set both, system/CLI paths set neither.
 *
 * `before` / `after` are conventional, not enforced: 'create' carries only
 * `after`, 'delete' only `before`, 'update' both. The entity does not police
 * that — a half-populated audit row is still worth more than a lost one.
 */
export class AuditLogEntry {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly entityType: AuditEntityType,
    readonly entityId: string,
    readonly action: AuditAction,
    readonly actorUserId: string | null,
    readonly actorStaffId: string | null,
    readonly before: AuditSnapshot | null,
    readonly after: AuditSnapshot | null,
    readonly createdAt: Date,
  ) {}

  static create(input: CreateAuditLogEntryInput): AuditLogEntry {
    return new AuditLogEntry(
      input.id,
      input.kindergartenId,
      input.entityType,
      input.entityId,
      input.action,
      input.actorUserId ?? null,
      input.actorStaffId ?? null,
      input.before ?? null,
      input.after ?? null,
      input.createdAt,
    );
  }

  static hydrate(state: AuditLogEntryState): AuditLogEntry {
    return new AuditLogEntry(
      state.id,
      state.kindergartenId,
      state.entityType,
      state.entityId,
      state.action,
      state.actorUserId,
      state.actorStaffId,
      state.before,
      state.after,
      state.createdAt,
    );
  }

  toState(): AuditLogEntryState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      entityType: this.entityType,
      entityId: this.entityId,
      action: this.action,
      actorUserId: this.actorUserId,
      actorStaffId: this.actorStaffId,
      before: this.before,
      after: this.after,
      createdAt: this.createdAt,
    };
  }
}
