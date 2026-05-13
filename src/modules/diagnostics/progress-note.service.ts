import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  ListProgressNotesFilter,
  ProgressNoteListResult,
  ProgressNoteRepository,
} from './progress-note.repository';
import {
  ProgressNote,
  ProgressNoteState,
  ProgressNoteUpdatePatch,
} from './domain/entities/progress-note.entity';
import { ProgressNoteNotFoundError } from './domain/errors/progress-note-not-found.error';

export interface CreateProgressNoteInput {
  childId: string;
  mentorId: string;
  body: string;
  mediaUrls?: string[];
  notedAt?: Date;
}

@Injectable()
export class ProgressNoteService {
  constructor(
    private readonly notes: ProgressNoteRepository,
    private readonly children: ChildRepository,
    private readonly notification: NotificationPort,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Create a new progress note. The entity invariant rejects empty body
   * and `notedAt > now + 5min`. Emits `progress_note.new` for guardian
   * fan-out via the dispatcher.
   *
   * Tenant-scoped child existence check is service-side defense-in-depth
   * against cross-tenant child_id reference (see B18 T7 review). The DB-side
   * composite UNIQUE `(kindergarten_id, id)` on `children` plus a same-tenant
   * FK from `progress_notes.child_id` is deferred to B22.
   */
  async create(
    kgId: string,
    input: CreateProgressNoteInput,
  ): Promise<ProgressNote> {
    const child = await this.children.findById(kgId, input.childId);
    if (child === null) {
      throw new ChildNotFoundError(input.childId);
    }
    const now = this.clock.now();
    const state: ProgressNoteState = {
      id: randomUUID(),
      kindergartenId: kgId,
      childId: input.childId,
      mentorId: input.mentorId,
      body: input.body,
      mediaUrls: Array.isArray(input.mediaUrls) ? input.mediaUrls : [],
      notedAt: input.notedAt ?? now,
      createdAt: now,
      // B22a T4 — optimistic-lock token starts at 1 (matches DB DEFAULT).
      rowVersion: 1,
    };
    const note = ProgressNote.fromState(state, now);
    const persisted = await this.notes.create(note);

    await this.notification.notifyProgressNoteNew({
      kindergartenId: kgId,
      childId: persisted.childId,
      noteId: persisted.id,
      mentorId: persisted.mentorId,
      notedAt: persisted.notedAt,
      createdAt: persisted.createdAt,
    });

    return persisted;
  }

  /**
   * PATCH body / mediaUrls. Author-only — `assertAuthoredBy` throws 403
   * on mismatch. Empty body rejected by the entity invariant (400).
   *
   * Race protection (B22a T4 — closes B18 T6-M4): `expectedRowVersion`
   * captured BEFORE the domain mutation; concurrent PATCHes serialise
   * via the conditional UPDATE in the relational repo. Late writers
   * receive `OptimisticLockError` (HTTP 409).
   */
  async update(
    kgId: string,
    id: string,
    callerMentorId: string,
    patch: ProgressNoteUpdatePatch,
  ): Promise<ProgressNote> {
    const existing = await this.notes.findById(kgId, id);
    if (existing === null) {
      throw new ProgressNoteNotFoundError(id);
    }
    existing.assertAuthoredBy(callerMentorId);
    const expectedRowVersion = existing.rowVersion;
    const updated = existing.update(patch, this.clock.now());
    return this.notes.update(updated, expectedRowVersion);
  }

  /**
   * DELETE a note. Author can always delete; non-author non-admin → 403.
   * Admin override is handled by the `isAdmin` flag at the controller
   * layer.
   */
  async delete(
    kgId: string,
    id: string,
    callerStaffMemberId: string,
    isAdmin: boolean,
  ): Promise<void> {
    const existing = await this.notes.findById(kgId, id);
    if (existing === null) {
      throw new ProgressNoteNotFoundError(id);
    }
    if (!isAdmin) {
      existing.assertAuthoredBy(callerStaffMemberId);
    }
    const ok = await this.notes.delete(kgId, id);
    if (!ok) {
      // Race: someone else already deleted. Surface as 404 — the row no
      // longer exists from the caller's POV.
      throw new ProgressNoteNotFoundError(id);
    }
  }

  async getById(kgId: string, id: string): Promise<ProgressNote> {
    const existing = await this.notes.findById(kgId, id);
    if (existing === null) {
      throw new ProgressNoteNotFoundError(id);
    }
    return existing;
  }

  async listByChild(
    kgId: string,
    childId: string,
    filters: { from?: Date; to?: Date; cursor?: string; limit: number },
  ): Promise<ProgressNoteListResult> {
    return this.notes.list(kgId, { ...filters, childId });
  }

  async listByKgFiltered(
    kgId: string,
    filters: ListProgressNotesFilter,
  ): Promise<ProgressNoteListResult> {
    return this.notes.list(kgId, filters);
  }
}
