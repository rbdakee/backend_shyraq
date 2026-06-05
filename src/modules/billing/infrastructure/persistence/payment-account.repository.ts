import { EntityManager } from 'typeorm';
import { PaymentAccount } from '../../domain/entities/payment-account.entity';

/**
 * Persistence port for `payment_accounts`. Per-child running balance
 * ledger; one row per `(kindergarten_id, child_id)` pair (UNIQUE in DB).
 */
export abstract class PaymentAccountRepository {
  /**
   * Idempotent UPSERT: returns the existing account for `(kg, child)` if
   * one exists, otherwise creates and returns it. Race-safe — relies on
   * the UNIQUE constraint and `INSERT ... ON CONFLICT DO NOTHING` to
   * collapse concurrent first-creates.
   *
   * Caller may pass an explicit `manager` (cron / outbox); otherwise the
   * impl resolves the ambient tenant manager from `tenantStorage`.
   */
  abstract findOrCreateForChild(
    kindergartenId: string,
    childId: string,
    manager?: EntityManager,
  ): Promise<PaymentAccount>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<PaymentAccount | null>;

  abstract findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount | null>;

  /**
   * Persists the aggregate after a mutator (`credit`/`debit`). Updates the
   * `balance` and `updated_at` columns; `id`, `kindergarten_id`, `child_id`,
   * and `created_at` are not re-written.
   */
  abstract save(account: PaymentAccount): Promise<PaymentAccount>;

  /**
   * Serialises concurrent balance mutations on ONE payment_account.
   * `pg_advisory_xact_lock(hashtext('billing:account:'||accountId))` —
   * released at TX commit/rollback. MUST be called inside the ambient
   * settlement TX, before the read-modify-write in credit/debit, so two
   * settlements for DIFFERENT invoices of the SAME child's account cannot
   * lost-update the running balance (the per-invoice lock does not cover
   * this — the account is per-child).
   *
   * Non-abstract default no-op so the many in-memory fakes that extend this
   * port keep compiling without changes (matches the repo's default-no-op
   * convention, e.g. `sumCompletedBetween` on PaymentRepository). The
   * relational impl overrides it with the real lock.
   */
  acquireBalanceAdvisoryLock(
    _kindergartenId: string,
    _accountId: string,
  ): Promise<void> {
    return Promise.resolve();
  }
}
