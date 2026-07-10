import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Attempted to DELETE a specialist type that is still referenced by at least
 * one `staff_members` row or `diagnostic_templates` row in this kindergarten.
 * Mapped to HTTP 409. `details.usage` reports the referencing counts.
 */
export class SpecialistTypeInUseError extends ConflictError {
  readonly details: { staff_members: number; diagnostic_templates: number };

  constructor(code: string, staffMembers: number, diagnosticTemplates: number) {
    super('specialist_type_in_use', `specialist_type in use: ${code}`);
    this.details = {
      staff_members: staffMembers,
      diagnostic_templates: diagnosticTemplates,
    };
  }
}
