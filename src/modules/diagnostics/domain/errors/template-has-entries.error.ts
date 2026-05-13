import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller tried to PATCH the JSONB `schema` of a `diagnostic_template`
 * that already has at least one persisted `diagnostic_entry`. Mutating the
 * schema would invalidate every existing entry's `data` payload (the
 * payload is validated against the live template schema on read).
 *
 * Closes B22a T7 / H12 (template-PATCH version-pinning).
 *
 * Non-schema patch fields (`name`, `description`, `is_active`) remain
 * editable even when entries exist — only structural schema changes are
 * blocked. To author a new schema while preserving old entries, the admin
 * must either (a) deactivate this template and create a fresh one with
 * `POST /admin/diagnostic-templates`, or (b) wait for the planned
 * `POST /admin/diagnostic-templates/:id/clone` endpoint (deferred to B22b)
 * which will spawn a new `version+1` row and leave the old one intact.
 */
export class TemplateHasEntriesError extends ConflictError {
  public readonly code = 'template_has_entries' as const;

  constructor(templateId: string, entriesCount: number) {
    super(
      'template_has_entries',
      `diagnostic_template ${templateId} has ${entriesCount} existing entries — schema is pinned`,
    );
  }
}
