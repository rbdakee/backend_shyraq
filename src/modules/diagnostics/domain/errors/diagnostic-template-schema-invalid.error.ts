import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — caller-supplied template `schema` does not match the contract:
 *   schema = { sections: [{ title, fields: [{ key, label, type, required, options?, min?, max? }] }] }
 *
 * `details` carries the offending JSON-path and a human-readable reason so
 * the admin UI can highlight the failing field. Mapped via the shared
 * `InvariantViolationError → 400` rule in `DomainErrorFilter`.
 */
export class DiagnosticTemplateSchemaInvalidError extends InvariantViolationError {
  public readonly code = 'diagnostic_template_schema_invalid' as const;
  public readonly details: { path: string; message: string };

  constructor(details: { path: string; message: string }) {
    super('diagnostic_template_schema_invalid');
    this.details = details;
  }
}
