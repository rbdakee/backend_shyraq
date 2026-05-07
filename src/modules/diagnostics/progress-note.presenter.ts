import {
  ProgressNoteListResponseDto,
  ProgressNoteResponseDto,
} from './dto/progress-note-response.dto';
import { ProgressNote } from './domain/entities/progress-note.entity';

export class ProgressNotePresenter {
  static one(note: ProgressNote): ProgressNoteResponseDto {
    const dto = new ProgressNoteResponseDto();
    dto.id = note.id;
    dto.kindergarten_id = note.kindergartenId;
    dto.child_id = note.childId;
    dto.mentor_id = note.mentorId;
    dto.body = note.body;
    dto.media_urls = note.mediaUrls;
    dto.noted_at = note.notedAt.toISOString();
    dto.created_at = note.createdAt.toISOString();
    return dto;
  }

  static list(
    items: ProgressNote[],
    nextCursor: string | null,
  ): ProgressNoteListResponseDto {
    const dto = new ProgressNoteListResponseDto();
    dto.items = items.map((n) => ProgressNotePresenter.one(n));
    dto.next_cursor = nextCursor;
    return dto;
  }
}
