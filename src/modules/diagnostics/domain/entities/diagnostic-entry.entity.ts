import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { DiagnosticEntryNotAuthoredByYouError } from '../errors/diagnostic-entry-not-authored-by-you.error';

/**
 * `DiagnosticEntry` — a filled assessment for one child against one
 * `DiagnosticTemplate.schema`. The `data` jsonb payload is opaque at the
 * domain level; structural validation against `template.schema` happens
 * in service.ts (T3) where the bound template is loaded alongside the
 * entry payload.
 *
 * `assessmentDate` is treated as a calendar date (PG `date` column) — only
 * the YYYY-MM-DD slice matters. The constructor enforces the same
 * "not-in-the-future" CHECK that the database does, comparing against the
 * current calendar date in Asia/Almaty (consistent with B8/B12).
 */
export interface DiagnosticEntryState {
  id: string;
  kindergartenId: string;
  childId: string;
  templateId: string;
  specialistId: string;
  assessmentDate: Date;
  data: Record<string, unknown>;
  summary: string | null;
  recommendations: string | null;
  attachments: string[];
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optimistic-lock token (B22a T4). Internal — not exposed via DTO.
   * Bumped by the relational repo's conditional UPDATE; the service
   * layer captures `loaded.rowVersion` and passes it back.
   */
  rowVersion: number;
  /**
   * Admin-bypass-on-PATCH audit fields (B22a T7 — closes B18 Concern 1).
   * Stamped by the service layer on every PATCH (including admin
   * override). NULL on never-patched rows. Internal — not exposed via DTO.
   */
  lastModifiedByUserId?: string | null;
  lastModifiedAt?: Date | null;
}

export interface DiagnosticEntryUpdatePatch {
  data?: Record<string, unknown>;
  summary?: string | null;
  recommendations?: string | null;
  attachments?: string[];
  /**
   * Audit stamps (B22a T7) — NOT user-supplied. The service layer fills
   * these from the current `req.user.sub` + `clock.now()` before calling
   * `entity.update()`. Kept on the patch (rather than as a separate
   * service-level argument) so the entity stays the single source of
   * truth for the next-state shape.
   */
  lastModifiedByUserId?: string | null;
  lastModifiedAt?: Date | null;
}

const ALMATY_TZ = 'Asia/Almaty';

function dateOnlyAlmaty(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ALMATY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export class DiagnosticEntry {
  private constructor(private readonly state: DiagnosticEntryState) {}

  /**
   * Build from raw state. Enforces the assessment-date invariant against
   * the supplied `now` reference (defaults to wall-clock when omitted, but
   * production callers should pass an injected `ClockPort.now()` to keep
   * tests deterministic).
   */
  static fromState(
    s: DiagnosticEntryState,
    now: Date = new Date(),
  ): DiagnosticEntry {
    DiagnosticEntry.assertInvariants(s, now);
    return new DiagnosticEntry({
      ...s,
      attachments: Array.isArray(s.attachments) ? [...s.attachments] : [],
    });
  }

  /**
   * Hydrate from persistence without re-running the calendar-date
   * invariant. Used by the relational mapper when loading a row that may
   * pre-date today's clock (e.g. seeded fixtures with `assessmentDate`
   * recorded historically).
   */
  static rehydrate(s: DiagnosticEntryState): DiagnosticEntry {
    if (!s.data || typeof s.data !== 'object') {
      throw new InvariantViolationError('data_must_be_object');
    }
    return new DiagnosticEntry({
      ...s,
      attachments: Array.isArray(s.attachments) ? [...s.attachments] : [],
    });
  }

  toState(): DiagnosticEntryState {
    return {
      ...this.state,
      attachments: [...this.state.attachments],
    };
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get childId(): string {
    return this.state.childId;
  }

  get templateId(): string {
    return this.state.templateId;
  }

  get specialistId(): string {
    return this.state.specialistId;
  }

  get assessmentDate(): Date {
    return this.state.assessmentDate;
  }

  get data(): Record<string, unknown> {
    return this.state.data;
  }

  get summary(): string | null {
    return this.state.summary;
  }

  get recommendations(): string | null {
    return this.state.recommendations;
  }

  get attachments(): string[] {
    return [...this.state.attachments];
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  get rowVersion(): number {
    return this.state.rowVersion;
  }

  get lastModifiedByUserId(): string | null {
    return this.state.lastModifiedByUserId ?? null;
  }

  get lastModifiedAt(): Date | null {
    return this.state.lastModifiedAt ?? null;
  }

  // ── invariants ───────────────────────────────────────────────────────────

  private static assertInvariants(s: DiagnosticEntryState, now: Date): void {
    if (
      !(s.assessmentDate instanceof Date) ||
      isNaN(s.assessmentDate.getTime())
    ) {
      throw new InvariantViolationError('invalid_assessment_date');
    }
    const todayAlmaty = dateOnlyAlmaty(now);
    const assessmentDay = dateOnlyAlmaty(s.assessmentDate);
    if (assessmentDay > todayAlmaty) {
      throw new InvariantViolationError('assessment_date_in_future');
    }
    if (!s.data || typeof s.data !== 'object' || Array.isArray(s.data)) {
      throw new InvariantViolationError('data_must_be_object');
    }
  }

  // ── methods ──────────────────────────────────────────────────────────────

  /**
   * Returns a new instance with `patch` applied. `assessmentDate` is set
   * once at creation and never mutated (per BP §8.4 — to amend the date
   * the entry must be deleted and re-created).
   */
  update(patch: DiagnosticEntryUpdatePatch, now: Date): DiagnosticEntry {
    const next: DiagnosticEntryState = {
      ...this.state,
      updatedAt: now,
      attachments: [...this.state.attachments],
    };
    if (patch.data !== undefined) {
      if (
        !patch.data ||
        typeof patch.data !== 'object' ||
        Array.isArray(patch.data)
      ) {
        throw new InvariantViolationError('data_must_be_object');
      }
      next.data = patch.data;
    }
    if (patch.summary !== undefined) {
      next.summary = patch.summary;
    }
    if (patch.recommendations !== undefined) {
      next.recommendations = patch.recommendations;
    }
    if (patch.attachments !== undefined) {
      next.attachments = [...patch.attachments];
    }
    // Audit stamps (B22a T7). Service layer always supplies them on PATCH
    // — but we copy from the patch only when present so this method
    // remains usable from internal flows (none today) that opt out of
    // audit stamping.
    if (patch.lastModifiedByUserId !== undefined) {
      next.lastModifiedByUserId = patch.lastModifiedByUserId;
    }
    if (patch.lastModifiedAt !== undefined) {
      next.lastModifiedAt = patch.lastModifiedAt;
    }
    return new DiagnosticEntry(next);
  }

  /**
   * 403 guard for non-admin specialists trying to mutate an entry not
   * authored by them. Admin callers skip this at the service layer.
   */
  assertAuthoredBy(specialistId: string): void {
    if (this.state.specialistId !== specialistId) {
      throw new DiagnosticEntryNotAuthoredByYouError();
    }
  }
}
