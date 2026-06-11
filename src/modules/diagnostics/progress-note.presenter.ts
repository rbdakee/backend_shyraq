import {
  ProgressNoteListResponseDto,
  ProgressNoteResponseDto,
} from './dto/progress-note-response.dto';
import { ProgressNote } from './domain/entities/progress-note.entity';

export class ProgressNotePresenter {
  /**
   * Maps a note → response DTO. The optional `mentorFullName` overlay carries
   * the display name resolved from `staff_members` → `users` (progress notes
   * store only `mentor_id`). Absent overlay → `mentor_full_name` falls back to
   * null. Mirrors the guardian identity overlay (`ChildPresenter.guardian`).
   */
  static one(
    note: ProgressNote,
    mentorFullName: string | null = null,
  ): ProgressNoteResponseDto {
    const dto = new ProgressNoteResponseDto();
    dto.id = note.id;
    dto.kindergarten_id = note.kindergartenId;
    dto.child_id = note.childId;
    dto.mentor_id = note.mentorId;
    dto.mentor_full_name = mentorFullName;
    dto.body = note.body;
    dto.media_urls = note.mediaUrls;
    dto.noted_at = note.notedAt.toISOString();
    dto.created_at = note.createdAt.toISOString();
    return dto;
  }

  static list(
    items: ProgressNote[],
    nextCursor: string | null,
    mentorNames?: Map<string, string | null>,
  ): ProgressNoteListResponseDto {
    const dto = new ProgressNoteListResponseDto();
    dto.items = items.map((n) =>
      ProgressNotePresenter.one(n, mentorNames?.get(n.mentorId) ?? null),
    );
    dto.next_cursor = nextCursor;
    return dto;
  }
}
