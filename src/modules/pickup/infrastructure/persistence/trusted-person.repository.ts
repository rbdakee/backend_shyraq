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
   * Cross-tenant lookup by id, bypassing RLS inside its own short
   * transaction. Used by `TrustedPersonAccessGuard` (Пакет C) to resolve the
   * OWNING kindergarten of a `trusted_people` row BEFORE the tenant
   * transaction is set up — the multi-kg parent JWT carries
   * `kindergarten_id: null`, so the kg must come from the resource.
   *
   * Resolves the kg ONLY — no authorisation. The `update` / `revoke` services
   * re-check ownership (original adder OR approved-active guardian of the same
   * child) in the resolved kg, so a guardian on kg_A can never mutate a
   * trusted_people row from kg_B even with a hand-crafted URL.
   *
   * Non-abstract default returns null so in-memory fakes (which never exercise
   * the guard path) need not implement it; the relational adapter overrides.
   */
  findByIdCrossTenant(_id: string): Promise<TrustedPerson | null> {
    return Promise.resolve(null);
  }

  /**
   * Lists active trusted_people rows for a given child within the tenant.
   * "Active" means `is_active=true AND revoked_at IS NULL` — revoked rows
   * are filtered out at the SQL layer to match docs/endpoints.md §4.6
   * "Whitelist доверенных для ребёнка. Возвращает is_active=true записи".
   * Sorted by `created_at DESC`.
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
   *
   * **Atomic claim semantics (T7-5 HIGH#2):** the SQL UPDATE is guarded
   * by `WHERE used_at IS NULL AND revoked_at IS NULL AND is_active = true`,
   * so concurrent validates trying to consume the same one-time
   * trusted_people row see exactly one winner. Returns `true` when the
   * row was claimed (1 row affected) or `false` when another path
   * already consumed it. Service callers MUST treat `false` as a
   * conflict on `is_one_time=true` rows and roll back the surrounding
   * TX (no attendance row, no validated state). For non-one-time rows
   * the boolean is informational — `false` simply means the row was
   * concurrently revoked, in which case the validate flow has already
   * been gated by `isAvailableForPickup()` upstream.
   */
  abstract markUsed(
    id: string,
    now: Date,
    deactivate: boolean,
  ): Promise<boolean>;
}
