import {
  DiagnosticEntryListResponseDto,
  DiagnosticEntryResponseDto,
} from './dto/diagnostic-entry-response.dto';
import { DiagnosticEntry } from './domain/entities/diagnostic-entry.entity';

/** Minimal template info used to populate computed fields on the response. */
export interface TemplateLookup {
  name: string;
  version: number;
}

export class DiagnosticEntryPresenter {
  /**
   * Convert a domain `DiagnosticEntry` to a response DTO. Pass the optional
   * `templateLookup` map to populate `template_name` and `template_version`
   * without triggering N+1 queries — the service fetches a single batch and
   * passes it here.
   *
   * `specialistFullName` is the identity overlay for `specialist_id` —
   * resolved by `DiagnosticEntryService.resolveSpecialistNames` via the
   * staff identity fallback. Defaults to null so existing callers that
   * don't thread the overlay still compile and render `null`.
   */
  static one(
    entry: DiagnosticEntry,
    templateLookup?: Map<string, TemplateLookup>,
    specialistFullName: string | null = null,
  ): DiagnosticEntryResponseDto {
    const lookup = templateLookup?.get(entry.templateId);
    const dto = new DiagnosticEntryResponseDto();
    dto.id = entry.id;
    dto.kindergarten_id = entry.kindergartenId;
    dto.child_id = entry.childId;
    dto.template_id = entry.templateId;
    dto.template_name = lookup?.name ?? '';
    dto.template_version = lookup?.version ?? 0;
    dto.specialist_id = entry.specialistId;
    dto.specialist_full_name = specialistFullName;
    // assessmentDate is a PG `date` column — slice to YYYY-MM-DD.
    dto.assessment_date = entry.assessmentDate.toISOString().slice(0, 10);
    dto.data = entry.data;
    dto.summary = entry.summary;
    dto.recommendations = entry.recommendations;
    dto.attachments = entry.attachments;
    dto.created_at = entry.createdAt.toISOString();
    dto.updated_at = entry.updatedAt.toISOString();
    return dto;
  }

  /**
   * `names` is the per-entry `specialist_full_name` overlay keyed by
   * `specialist_id` (see `DiagnosticEntryService.resolveSpecialistNames`).
   * Optional so callers that don't thread the overlay still render `null`.
   */
  static list(
    items: DiagnosticEntry[],
    nextCursor: string | null,
    templateLookup?: Map<string, TemplateLookup>,
    names?: Map<string, string | null>,
  ): DiagnosticEntryListResponseDto {
    const dto = new DiagnosticEntryListResponseDto();
    dto.items = items.map((e) =>
      DiagnosticEntryPresenter.one(
        e,
        templateLookup,
        names?.get(e.specialistId) ?? null,
      ),
    );
    dto.next_cursor = nextCursor;
    return dto;
  }
}
