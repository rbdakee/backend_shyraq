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
   * Conditional UPDATE. When `expectedVersion` is supplied, the implementation
   * issues `WHERE version = $expectedVersion` so a stale read does not
   * silently overwrite. On version mismatch the impl returns the freshly-
   * loaded row so the caller can decide; the service layer translates that
   * into a 409 if needed.
   *
   * When `expectedVersion` is omitted, the update is unconditional (race-
   * tolerant; admin-only writers + low contention).
   */
  abstract update(
    template: DiagnosticTemplate,
    expectedVersion?: number,
  ): Promise<DiagnosticTemplate>;

  abstract list(
    kgId: string,
    filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult>;
}
