import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
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
    private readonly notification: NotificationPort,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Create a new progress note. The entity invariant rejects empty body
   * and `notedAt > now + 5min`. Emits `progress_note.new` for guardian
   * fan-out via the dispatcher.
   */
  async create(
    kgId: string,
    input: CreateProgressNoteInput,
  ): Promise<ProgressNote> {
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
    const updated = existing.update(patch, this.clock.now());
    return this.notes.update(updated);
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
