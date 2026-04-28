import type { EntityManager } from 'typeorm';

export interface TenantContext {
  kgId: string | null;
  bypass: boolean;
  /**
   * TypeORM EntityManager bound to the transaction in which `SET LOCAL
   * app.kindergarten_id` (or `app.bypass_rls`) was issued. Repositories that
   * need to participate in the tenant-scoped transaction must use this manager
   * (via `getTenantContext()?.entityManager`) so their queries inherit the
   * GUC. When undefined, callers fall back to the default repository manager
   * (e.g. unit tests, migrations, system-level paths).
   */
  entityManager?: EntityManager;
}
