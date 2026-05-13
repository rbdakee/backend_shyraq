import {
  ProgressNote,
  ProgressNoteState,
} from '../../../../domain/entities/progress-note.entity';
import { ProgressNoteRelationalEntity } from '../entities/progress-note.entity';

export class ProgressNoteMapper {
  static toDomain(row: ProgressNoteRelationalEntity): ProgressNote {
    const state: ProgressNoteState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      childId: row.childId,
      mentorId: row.mentorId,
      body: row.body,
      mediaUrls: row.mediaUrls ?? [],
      notedAt: row.notedAt,
      createdAt: row.createdAt,
      rowVersion: Number(row.rowVersion ?? 1),
      // B22a T7 — audit columns round-tripped same way as the entry mapper.
      lastModifiedByUserId: row.lastModifiedByUserId ?? null,
      lastModifiedAt: row.lastModifiedAt ?? null,
    };
    // Rehydrate skips the future-skew check — historical rows can legitimately
    // exist with `noted_at` written under a different server clock.
    return ProgressNote.rehydrate(state);
  }

  static toRelational(
    note: ProgressNote,
  ): Partial<ProgressNoteRelationalEntity> {
    const s = note.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      mentorId: s.mentorId,
      body: s.body,
      mediaUrls: s.mediaUrls.length > 0 ? s.mediaUrls : null,
      notedAt: s.notedAt,
      createdAt: s.createdAt,
      rowVersion: s.rowVersion,
      lastModifiedByUserId: s.lastModifiedByUserId ?? null,
      lastModifiedAt: s.lastModifiedAt ?? null,
    };
  }
}
