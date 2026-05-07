import {
  DiagnosticTemplate,
  DiagnosticTemplateState,
} from '../../../../domain/entities/diagnostic-template.entity';
import { DiagnosticTemplateRelationalEntity } from '../entities/diagnostic-template.entity';

export class DiagnosticTemplateMapper {
  static toDomain(row: DiagnosticTemplateRelationalEntity): DiagnosticTemplate {
    const state: DiagnosticTemplateState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      specialistType: row.specialistType,
      name: row.name,
      description: row.description,
      version: row.version,
      isActive: row.isActive,
      schema: row.schema,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return DiagnosticTemplate.fromState(state);
  }

  static toRelational(
    template: DiagnosticTemplate,
  ): Partial<DiagnosticTemplateRelationalEntity> {
    const s = template.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      specialistType: s.specialistType,
      name: s.name,
      description: s.description,
      version: s.version,
      isActive: s.isActive,
      schema: s.schema,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
