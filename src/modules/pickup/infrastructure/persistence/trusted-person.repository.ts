import { TrustedPerson } from '../../domain/entities/trusted-person.entity';

export interface CreateTrustedPersonRow {
  kindergartenId: string;
  childId: string;
  addedByUserId: string;
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isOneTime: boolean;
}

export type TrustedPersonPatch = Partial<{
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isOneTime: boolean;
  isActive: boolean;
}>;

/**
 * Persistence port for the TrustedPerson aggregate (B11). Methods exchange
 * domain objects (`TrustedPerson`), not TypeORM entities — the relational
 * implementation owns the mapper translation.
 *
 * Tenant-scoped: the relational implementation participates in the ambient
 * tenant transaction set up by `TenantContextInterceptor`, so RLS filters
 * rows automatically. Service code still passes `kindergartenId` to keep
 * the intent explicit and IDE-navigable.
 */
export abstract class TrustedPersonRepository {
  /**
   * Inserts a new active trusted_people row. Returns the freshly persisted
   * domain aggregate (with the DB-assigned `id` and `createdAt`). The
   * `isActive` column defaults to true on the DB side.
   */
  abstract create(input: CreateTrustedPersonRow): Promise<TrustedPerson>;

  /**
   * Returns the trusted_people row by id, or `null` if it does not exist
   * within the caller's tenant scope (RLS-filtered) or has simply not been
   * created. Caller is responsible for the ownership / child match.
   */
  abstract findById(id: string): Promise<TrustedPerson | null>;

  /**
   * Lists all trusted_people rows for a given child within the tenant.
   * Includes both active and revoked rows — the caller decides whether to
   * filter (parent-app may want to show "previously trusted" rows greyed
   * out). Sorted by `created_at DESC`.
   */
  abstract listByChild(
    kindergartenId: string,
    childId: string,
  ): Promise<TrustedPerson[]>;

  /**
   * Partial update of mutable fields. Returns the updated domain aggregate
   * or `null` if the id does not resolve under the caller's tenant scope.
   * Lifecycle transitions (`revoke`, `markUsed`) have dedicated methods
   * below — `update` is for benign edits like phone / photoUrl / relation.
   */
  abstract update(
    id: string,
    patch: TrustedPersonPatch,
  ): Promise<TrustedPerson | null>;

  /**
   * Stamps `revoked_at = now` and flips `is_active = false`. Idempotent at
   * the SQL level — the WHERE clause guards against re-revoking. Service
   * still calls `TrustedPerson.revoke` to surface a domain error on a
   * second attempt; this DB call is the persistence half.
   */
  abstract markRevoked(id: string, now: Date): Promise<void>;

  /**
   * Stamps `used_at = now` and (when `deactivate` is true) flips
   * `is_active = false`. Service supplies `deactivate` based on the
   * domain aggregate's `isOneTime` flag.
   */
  abstract markUsed(id: string, now: Date, deactivate: boolean): Promise<void>;
}
