import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { ProgressNoteNotAuthoredByYouError } from '../errors/progress-note-not-authored-by-you.error';

/**
 * `ProgressNote` — a free-form mentor note attached to a child timeline.
 * Append-only at the DB level (no `updated_at` column), but mutator
 * methods are still provided so the service layer can issue surgical
 * `body` / `media_urls` patches as a manual `UPDATE` query (not via
 * trigger-driven timestamps).
 *
 * `notedAt` may be back-dated freely but cannot exceed `now + 5 minutes`
 * skew, mirroring the DB CHECK.
 */
export interface ProgressNoteState {
  id: string;
  kindergartenId: string;
  childId: string;
  mentorId: string;
  body: string;
  mediaUrls: string[];
  notedAt: Date;
  createdAt: Date;
}

export interface ProgressNoteUpdatePatch {
  body?: string;
  mediaUrls?: string[];
}

const FUTURE_SKEW_MS = 5 * 60 * 1000;

export class ProgressNote {
  private constructor(private readonly state: ProgressNoteState) {}

  /**
   * Build from raw state. Enforces invariants against `now`. Used both
   * for new-note construction and freshly-supplied state.
   */
  static fromState(s: ProgressNoteState, now: Date = new Date()): ProgressNote {
    ProgressNote.assertInvariants(s, now);
    return new ProgressNote({
      ...s,
      mediaUrls: Array.isArray(s.mediaUrls) ? [...s.mediaUrls] : [],
    });
  }

  /**
   * Hydrate from persistence without re-running the future-skew check.
   * Used by the relational mapper for rows that may have been written
   * with a server clock different from the test's injected clock.
   */
  static rehydrate(s: ProgressNoteState): ProgressNote {
    if (typeof s.body !== 'string' || s.body.trim() === '') {
      throw new InvariantViolationError('empty_body');
    }
    return new ProgressNote({
      ...s,
      mediaUrls: Array.isArray(s.mediaUrls) ? [...s.mediaUrls] : [],
    });
  }

  toState(): ProgressNoteState {
    return {
      ...this.state,
      mediaUrls: [...this.state.mediaUrls],
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

  get mentorId(): string {
    return this.state.mentorId;
  }

  get body(): string {
    return this.state.body;
  }

  get mediaUrls(): string[] {
    return [...this.state.mediaUrls];
  }

  get notedAt(): Date {
    return this.state.notedAt;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  // ── invariants ───────────────────────────────────────────────────────────

  private static assertInvariants(s: ProgressNoteState, now: Date): void {
    if (typeof s.body !== 'string' || s.body.trim() === '') {
      throw new InvariantViolationError('empty_body');
    }
    if (!(s.notedAt instanceof Date) || isNaN(s.notedAt.getTime())) {
      throw new InvariantViolationError('invalid_noted_at');
    }
    if (s.notedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw new InvariantViolationError('noted_at_in_future');
    }
  }

  // ── methods ──────────────────────────────────────────────────────────────

  /**
   * Returns a new instance with `patch` applied. Body must remain
   * non-empty. The schema has no `updated_at` column, so this method
   * does not advance any timestamp; the service may persist the patched
   * row directly.
   */
  update(patch: ProgressNoteUpdatePatch, _now: Date): ProgressNote {
    const next: ProgressNoteState = {
      ...this.state,
      mediaUrls: [...this.state.mediaUrls],
    };
    if (patch.body !== undefined) {
      if (typeof patch.body !== 'string' || patch.body.trim() === '') {
        throw new InvariantViolationError('empty_body');
      }
      next.body = patch.body;
    }
    if (patch.mediaUrls !== undefined) {
      next.mediaUrls = [...patch.mediaUrls];
    }
    return new ProgressNote(next);
  }

  /**
   * 403 guard for non-admin mentors trying to mutate a note not authored
   * by them. Admin callers skip this at the service layer.
   */
  assertAuthoredBy(mentorId: string): void {
    if (this.state.mentorId !== mentorId) {
      throw new ProgressNoteNotAuthoredByYouError();
    }
  }
}
