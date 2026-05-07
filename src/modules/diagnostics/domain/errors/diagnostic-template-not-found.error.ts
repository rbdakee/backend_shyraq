import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a diagnostic_template id that is not visible
 * under the caller's tenant scope (or simply does not exist).
 */
export class DiagnosticTemplateNotFoundError extends NotFoundError {
  public readonly code = 'diagnostic_template_not_found' as const;

  constructor(templateId: string) {
    super('diagnostic_template', templateId);
  }
}
