import { EntityManager } from 'typeorm';
import {
  Invoice,
  InvoiceStatus,
  InvoiceType,
} from '../../domain/entities/invoice.entity';
import { InvoiceLineItem } from '../../domain/entities/invoice-line-item.entity';

export interface ListInvoicesFilter {
  status?: InvoiceStatus;
  /**
   * ISO date `YYYY-MM-DD`. Filters `due_date <= dueDateTo`.
   * Kept as `dueDate` for legacy callers (T11 H2 added `dueDateFrom` as the
   * matching lower bound; old code that only set `dueDate` continues to mean
   * "upper bound").
   */
  dueDate?: string;
  /** ISO date `YYYY-MM-DD`. Filters `due_date >= dueDateFrom`. */
  dueDateFrom?: string;
  childId?: string;
  invoiceType?: InvoiceType;
  /** ISO date `YYYY-MM-DD`. Filters `period_start >= periodStart`. */
  periodStart?: string;
  /** ISO date `YYYY-MM-DD`. Filters `period_end <= periodEnd`. */
  periodEnd?: string;
}

/**
 * Persistence port for the Invoice aggregate (B13).
 *
 * T3 declared only `acquireMonthlyGenerationAdvisoryLock`. T4a adds the full
 * CRUD surface plus the conditional-UPDATE state-flip helpers used by
 * `InvoiceService` (markPaid / markPartial / markCancelled / markRefunded /
 * markOverdue). Each conditional method returns the updated `Invoice` on
 * success or `null` if the row was already in a different state — the
 * service maps `null` to a domain error.
 *
 * Tenant-scoped: the relational impl participates in the ambient tenant TX
 * established by `TenantContextInterceptor`, so RLS filters rows
 * automatically.
 */
export abstract class InvoiceRepository {
  /**
   * Atomic INSERT of an invoice plus its line items in a single TX. If a
   * caller-provided `manager` is supplied (e.g. cron processor running
   * inside `dataSource.transaction(em => …)`) it is used; otherwise the
   * relational impl falls back to the ambient tenant manager from
   * `tenantStorage`.
   */
  abstract create(
    invoice: Invoice,
    lineItems: InvoiceLineItem[],
    manager?: EntityManager,
  ): Promise<Invoice>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<Invoice | null>;

  abstract list(
    kindergartenId: string,
    filter: ListInvoicesFilter,
  ): Promise<Invoice[]>;

  abstract findByChildId(
    kindergartenId: string,
    childId: string,
    filter?: Omit<ListInvoicesFilter, 'childId'>,
  ): Promise<Invoice[]>;

  /**
   * Returns `true` iff the kindergarten already has at least one
   * `invoice_type='monthly'` invoice whose `period_start` matches the
   * canonical first-of-month date. Used by the monthly cron to short-circuit
   * when a previous run already generated monthly invoices for
   * `(kg, periodStart)` — paired with the advisory lock for defence-in-depth
   * (B7 idempotency pattern).
   *
   * **Note (T11 C1):** previous to T11 this method matched ANY invoice_type,
   * which meant a parent prepayment (period_start = first-of-next-month) or
   * a manual one-off invoice with a same first-of-month period_start could
   * silently block the entire kg's monthly generation. The filter ensures
   * only `monthly` rows participate in the short-circuit decision.
   */
  abstract existsMonthlyForPeriod(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<boolean>;

  /**
   * Sums `payments.amount` for the given invoice across rows where
   * `status='completed'`. Used by `InvoiceService.manualMarkPaid` and by
   * webhook handlers (T5a) to reconstruct the running paid total before
   * calling `Invoice.applyPayment`.
   */
  abstract getPaidSumForInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<number>;

  /**
   * Conditional UPDATE: `SET status='paid', updated_at=$now WHERE id=$id AND
   * kindergarten_id=$kg AND status IN ('pending','partial','overdue')
   * RETURNING *`. Returns the hydrated domain on success, `null` on
   * 0-rows.
   */
  abstract markPaidConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null>;

  /** Same shape as `markPaidConditional` but flips `→ partial`. */
  abstract markPartialConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null>;

  /** Same shape; flips `→ cancelled` from pending|partial|overdue. */
  abstract markCancelledConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null>;

  /** Same shape; flips `→ refunded` from paid|partial. */
  abstract markRefundedConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null>;

  /**
   * Same shape; flips `→ overdue` only from `pending`. Used by an
   * eventual `OverdueInvoicesProcessor` (deferred) and by manual
   * super-admin tooling.
   */
  abstract markOverdueConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null>;

  /**
   * Acquires `pg_advisory_xact_lock(hashtext('billing:monthly:'||kgId||':'||YYYY-MM))`.
   * Released automatically when the surrounding TX commits or rolls back.
   * See T3 docstring on the relational impl for full rationale.
   */
  abstract acquireMonthlyGenerationAdvisoryLock(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<void>;
}
