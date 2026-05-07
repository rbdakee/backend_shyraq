import {
  DiagnosticTemplateListResponseDto,
  DiagnosticTemplateResponseDto,
} from './dto/diagnostic-template-response.dto';
import { DiagnosticTemplate } from './domain/entities/diagnostic-template.entity';

export class DiagnosticTemplatePresenter {
  static one(template: DiagnosticTemplate): DiagnosticTemplateResponseDto {
    const dto = new DiagnosticTemplateResponseDto();
    dto.id = template.id;
    dto.kindergarten_id = template.kindergartenId;
    dto.specialist_type = template.specialistType;
    dto.name = template.name;
    dto.description = template.description;
    dto.version = template.version;
    dto.is_active = template.isActive;
    dto.schema = template.schema as Record<string, unknown>;
    dto.created_by = template.createdBy;
    dto.created_at = template.createdAt.toISOString();
    dto.updated_at = template.updatedAt.toISOString();
    return dto;
  }

  static list(
    items: DiagnosticTemplate[],
    nextCursor: string | null,
  ): DiagnosticTemplateListResponseDto {
    const dto = new DiagnosticTemplateListResponseDto();
    dto.items = items.map((t) => DiagnosticTemplatePresenter.one(t));
    dto.next_cursor = nextCursor;
    return dto;
  }
}
