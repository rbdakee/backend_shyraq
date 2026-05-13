import { UnprocessableEntityError } from '@/shared-kernel/domain/errors';

/**
 * 422 — caller-supplied template `schema` exceeds one of the hard caps
 * enforced by `validateTemplateSchemaShape` (DoS hardening, B22a-T6 / H10):
 *
 *   - sections.length        ≤ MAX_SECTIONS               (20)
 *   - section.fields.length  ≤ MAX_FIELDS_PER_SECTION     (50)
 *   - field.options.length   ≤ MAX_OPTIONS_PER_FIELD      (100)
 *   - any string (key/label/option) length ≤ MAX_STRING_LENGTH (200)
 *
 * `details` carries the offending JSON-path and the violated cap so the
 * admin UI can surface a precise message. Mapped to HTTP 422 via the
 * shared `UnprocessableEntityError` rule in `DomainErrorFilter`.
 */
export class SchemaTooLargeError extends UnprocessableEntityError {
  public readonly details: { path: string; limit: string };

  constructor(details: { path: string; limit: string }) {
    super('schema_too_large', 'schema_too_large');
    this.details = details;
  }
}
