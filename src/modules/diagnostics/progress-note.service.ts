import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffService } from '@/modules/staff/staff.service';
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

/** Returns the trimmed value, or null when empty/whitespace-only/absent. */
function nonBlankOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class ProgressNoteService {
  constructor(
    private readonly notes: ProgressNoteRepository,
    private readonly children: ChildRepository,
    private readonly notification: NotificationPort,
    private readonly clock: ClockPort,
    // Optional so older spec wiring keeps compiling. Used by
    // `findStaffMemberByUserIdOrThrow` — fails closed when missing.
    private readonly staffMembers?: StaffMemberRepository,
    // Optional for the same reason. Used by `resolveMentorNames` to reuse
    // the staff identity fallback (`staff.full_name ?? users.full_name`).
    // When missing, name resolution fails closed → `mentor_full_name = null`.
    private readonly staffService?: StaffService,
  ) {}

  /**
   * Identity overlay for progress-note lists — resolves each note's
   * `mentor_id` (a `staff_members.id`) to a display name via the staff
   * identity fallback (`staff_members.full_name ?? users.full_name`).
   * Mirrors `ChildService.resolveGuardianIdentities`: distinct `mentor_id`s
   * are looked up once and returned as a map keyed by `mentor_id`.
   *
   * Blank/whitespace-only names collapse to null so the client can fall back
   * cleanly. Fails closed: if the staff ports are not wired (legacy spec
   * construction) or a mentor row is missing, that entry resolves to null.
   */
  async resolveMentorNames(
    kgId: string,
    notes: ProgressNote[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.staffMembers || !this.staffService) {
      return out;
    }
    const distinctMentorIds = [...new Set(notes.map((n) => n.mentorId))];
    for (const mentorId of distinctMentorIds) {
      const member = await this.staffMembers.findById(kgId, mentorId);
      if (!member) {
        out.set(mentorId, null);
        continue;
      }
      const identity = await this.staffService.resolveIdentity(member);
      out.set(mentorId, nonBlankOrNull(identity.fullName));
    }
    return out;
  }

  /**
   * Resolve a user → their active staff_members row in this kindergarten.
   * Pulled out of the staff progress-note controller (CLAUDE.md §4 —
   * controllers stay thin HTTP-edge). Throws
   * `NotFoundException('staff_member_not_found')` on missing.
   */
  async findStaffMemberByUserIdOrThrow(
    kgId: string,
    userId: string,
  ): Promise<StaffMember> {
    if (!this.staffMembers) {
      throw new NotFoundException('staff_member_not_found');
    }
    const staffMember = await this.staffMembers.findActiveByUserAndKindergarten(
      userId,
      kgId,
    );
    if (!staffMember) {
      throw new NotFoundException('staff_member_not_found');
    }
    return staffMember;
  }

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
   *
   * Audit stamping (B22a T7 — closes B18 Concern 1): `callerUserId` is
   * the caller's `users.id` (not `staff_members.id`) — see
   * `DiagnosticEntryService.update` for the same rationale. Surfaces
   * the admin-override audit trail in `last_modified_by_user_id` /
   * `last_modified_at`.
   */
  async update(
    kgId: string,
    id: string,
    callerMentorId: string,
    callerUserId: string,
    patch: ProgressNoteUpdatePatch,
  ): Promise<ProgressNote> {
    const existing = await this.notes.findById(kgId, id);
    if (existing === null) {
      throw new ProgressNoteNotFoundError(id);
    }
    existing.assertAuthoredBy(callerMentorId);
    const expectedRowVersion = existing.rowVersion;
    const now = this.clock.now();
    const updated = existing.update(
      {
        ...patch,
        lastModifiedByUserId: callerUserId,
        lastModifiedAt: now,
      },
      now,
    );
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
