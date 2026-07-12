import { SpecialistType } from '../../domain/entities/specialist-type.entity';

export interface ListSpecialistTypesFilter {
  /** When true, include inactive rows; default false (active only). */
  includeInactive?: boolean;
}

export interface SpecialistTypeUsage {
  staffMembers: number;
  diagnosticTemplates: number;
}

/**
 * Port over the `specialist_types` directory. Implementations are tenant-aware
 * via `tenantStorage`; every method takes an explicit `kindergartenId` (RLS is
 * the second line of defense).
 */
export abstract class SpecialistTypeRepository {
  abstract create(entity: SpecialistType): Promise<SpecialistType>;
  abstract save(entity: SpecialistType): Promise<SpecialistType>;
  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<SpecialistType | null>;
  abstract findByCode(
    kindergartenId: string,
    code: string,
  ): Promise<SpecialistType | null>;
  /** True iff an ACTIVE row with this code exists — the validation predicate. */
  abstract existsActiveByCode(
    kindergartenId: string,
    code: string,
  ): Promise<boolean>;
  abstract list(
    kindergartenId: string,
    filter?: ListSpecialistTypesFilter,
  ): Promise<SpecialistType[]>;
  abstract delete(kindergartenId: string, id: string): Promise<boolean>;
  /** Referencing counts across staff_members + diagnostic_templates. */
  abstract countUsage(
    kindergartenId: string,
    code: string,
  ): Promise<SpecialistTypeUsage>;
  /**
   * Idempotently insert the system default rows for a kindergarten (ON
   * CONFLICT (kindergarten_id, code) DO NOTHING). Used by the new-kindergarten
   * create-hook.
   */
  abstract seedSystemDefaults(kindergartenId: string): Promise<void>;
}
