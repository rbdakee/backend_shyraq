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
}
