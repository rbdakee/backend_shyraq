import { KaspiMerchantSession } from '../../domain/entities/kaspi-merchant-session.entity';

/**
 * Persistence port for the `kaspi_merchant_session` aggregate (B24 / K5).
 *
 * One row per kindergarten (UNIQUE kindergarten_id). Tenant-scoped: the
 * relational impl resolves the ambient `EntityManager` from `tenantStorage`
 * (set by `TenantContextInterceptor`), so RLS filters rows automatically. The
 * service still passes `kindergartenId` explicitly for readability + defence
 * in depth (per CLAUDE.md §5/§8).
 *
 * `findByKindergartenIdBypassRls` is the only cross-tenant method — the K8
 * background poller runs without an HTTP tenant context and needs to load a
 * session by kindergarten without a GUC. The relational impl opens its own TX
 * with `SET LOCAL app.bypass_rls='true'` so the GUC does not leak into any
 * ambient TX (mirrors `PaymentRepository.findByProviderTxnIdCrossTenant`).
 */
export abstract class KaspiMerchantSessionRepository {
  /** Loads the single session for a kindergarten, or null if none exists. */
  abstract findByKindergartenId(
    kindergartenId: string,
  ): Promise<KaspiMerchantSession | null>;

  /**
   * Cross-tenant load by kindergarten id under `bypass_rls=true`, in a fresh
   * TX. Used by the K8 poller / refresh paths that run outside an HTTP request.
   */
  abstract findByKindergartenIdBypassRls(
    kindergartenId: string,
  ): Promise<KaspiMerchantSession | null>;

  /**
   * Upserts the session row for a kindergarten (INSERT ... ON CONFLICT
   * (kindergarten_id) DO UPDATE). Re-onboarding OVERWRITES the existing row
   * rather than inserting a duplicate (UNIQUE kindergarten_id). Returns the
   * persisted aggregate.
   */
  abstract save(session: KaspiMerchantSession): Promise<KaspiMerchantSession>;

  /**
   * Upserts the session row under `bypass_rls=true`, in a fresh self-contained
   * TX. Used by the K8 poller / refresh paths that run outside an HTTP request
   * (no ambient tenant EntityManager). Without this the FORCE-RLS write would
   * silently affect 0 rows. Mirrors `findByKindergartenIdBypassRls`.
   */
  abstract saveBypassRls(
    session: KaspiMerchantSession,
  ): Promise<KaspiMerchantSession>;
}
