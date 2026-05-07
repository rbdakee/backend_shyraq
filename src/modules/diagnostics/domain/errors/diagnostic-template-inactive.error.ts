import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller tried to mutate (deactivate / increment-version / use to
 * author an entry) a template that is already inactive. Inactive templates
 * are read-only — only previously created entries that reference them can
 * still be read.
 */
export class DiagnosticTemplateInactiveError extends ConflictError {
  public readonly code = 'diagnostic_template_inactive' as const;

  constructor(templateId: string) {
    super(
      'diagnostic_template_inactive',
      `diagnostic_template ${templateId} is inactive`,
    );
  }
}
