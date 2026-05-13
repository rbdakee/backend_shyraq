import { DiagnosticTemplate } from './domain/entities/diagnostic-template.entity';

/**
 * Filter shape for `DiagnosticTemplateRepository.list`. All fields optional;
 * service layer composes from controller query params.
 *
 * Cursor pagination: `cursor` opaque-strings the keyset over
 * `(updated_at DESC, id DESC)`. The relational impl encodes/decodes.
 * `limit` is required (default 20 enforced in the service).
 */
export interface ListDiagnosticTemplatesFilter {
  specialistType?: string;
  isActive?: boolean;
  cursor?: string;
  limit: number;
}

export interface DiagnosticTemplateListResult {
  items: DiagnosticTemplate[];
  nextCursor: string | null;
}

/**
 * Persistence port for `diagnostic_templates`. Every method takes
 * `kindergartenId` explicitly (RLS is defence-in-depth, not the contract
 * boundary) and returns POJO domain entities.
 */
export abstract class DiagnosticTemplateRepository {
  /** INSERT and return the rehydrated entity. */
  abstract create(template: DiagnosticTemplate): Promise<DiagnosticTemplate>;

  abstract findById(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null>;

  /**
   * Batch lookup by id. Returns a `Map<id, template>` so callers can
   * `O(1)`-resolve a presenter join without writing N round-trips.
   *
   * Closes B18 M6 (B22b T5) — the staff/parent diagnostic-entry list
   * presenters previously did `Promise.all(ids.map(getById))` which
   * fired N parallel SELECT-by-id round-trips per page load. The
   * relational impl issues a single `WHERE id = ANY($2) AND kg = $1`.
   *
   * Cross-tenant: templates not in `kgId` are silently absent from the
   * returned map (no error). Deleted templates also absent — callers
   * already render an empty `template_name` fallback.
   *
   * Passing an empty `ids` array returns an empty map without
   * issuing any query.
   */
  abstract listByIds(
    kgId: string,
    ids: string[],
  ): Promise<Map<string, DiagnosticTemplate>>;

  /**
   * SELECT ... FOR UPDATE inside an ambient transaction (provided by the
   * tenantStorage interceptor). Used by service-layer flows that need to
   * read-then-write under a row lock, e.g. concurrent PATCH.
   */
  abstract findByIdForUpdate(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null>;

  /**
   * Conditional UPDATE for optimistic-lock race protection (B22a T4).
   *
   * When `expectedRowVersion` is supplied, the implementation issues
   * `WHERE row_version = $expectedRowVersion` and bumps `row_version`
   * by 1 in the same statement. If zero rows match (someone else
   * mutated the row between the caller's read and write), the impl
   * throws `OptimisticLockError` (HTTP 409 `optimistic_lock_conflict`).
   *
   * When `expectedRowVersion` is omitted, the update is unconditional —
   * retained for any internal callers (none today) that opt out of
   * race protection. All HTTP-facing service paths supply it.
   *
   * NOTE: `row_version` is the OPTIMISTIC-LOCK token (internal only),
   * distinct from the public `version` field which represents the
   * SCHEMA version (semantic, exposed via DTO, bumped only on schema
   * diff). See B22a T4 + SM3.
   */
  abstract update(
    template: DiagnosticTemplate,
    expectedRowVersion?: number,
  ): Promise<DiagnosticTemplate>;

  abstract list(
    kgId: string,
    filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult>;

  /**
   * Returns the number of `diagnostic_entries` rows that reference this
   * template inside the given kindergarten. Used by H12
   * (B22a T7) to guard schema-PATCH against a template that already has
   * persisted entries — mutating the schema would invalidate every
   * existing entry's `data` payload.
   *
   * Lives on the template repo (not the entry repo) because the use-case
   * is template-side: the template's own `update()` flow needs the count
   * BEFORE any mutation. Keeping it here also avoids cross-port plumbing
   * inside `DiagnosticTemplateService`.
   */
  abstract countEntriesUsingTemplate(
    kgId: string,
    templateId: string,
  ): Promise<number>;
}
