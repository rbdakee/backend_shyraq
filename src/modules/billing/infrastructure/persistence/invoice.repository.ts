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
   * Same shape; flips `→ overdue` from `pending` OR `partial`. Used by
   * the nightly `OverdueInvoiceProcessor` (B22a T1) and by manual
   * super-admin tooling. The `partial` source was added in B22a T1 SM1
   * — an invoice that received any settlement (pending → partial) but
   * has the remaining amount past due_date is just as overdue as a
   * `pending` invoice with no payment, and dunning must apply equally.
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

  /**
   * B22a T13 M5 — `pg_advisory_xact_lock(hashtext('billing:overdue:'||
   * kgId||':'||YYYY-MM-DD)::bigint)` for the overdue-invoice nightly
   * cron. Held for the duration of the per-kg ambient TX so two
   * concurrent ticks (manual saas trigger + recurring) cannot
   * double-emit `invoice.overdue` notifications for the same flipped
   * row. Released automatically on TX commit / rollback.
   *
   * `today` is the Asia/Almaty calendar date (`YYYY-MM-DD`) so the same
   * Almaty day across multiple ticks contends for the same lock. Two
   * ticks anchored on different local days target different invoices
   * anyway and need not contend.
   *
   * Default no-op so older fakes compile; relational impl overrides.
   */
  acquireOverdueRunAdvisoryLock(
    _kindergartenId: string,
    _today: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  // ── B22a T1 — OverdueInvoiceProcessor batch helper ─────────────────────

  /**
   * Bulk `(pending | partial) → overdue` flip for one kg. Used by the
   * nightly cron processor. Single-statement conditional UPDATE so the
   * batch is atomic per kg and reports back exactly which rows the
   * cron just flipped (the `RETURNING` list seeds the
   * `invoice.overdue` event producer).
   *
   *   `UPDATE invoices
   *       SET status = 'overdue', updated_at = $3
   *     WHERE kindergarten_id = $1
   *       AND status IN ('pending', 'partial')
   *       AND due_date < $2::date
   *     RETURNING id, child_id, amount_after_discount, due_date`
   *
   * `today` is an explicit Asia/Almaty calendar date (`YYYY-MM-DD`)
   * supplied by the caller (B22a T13 M1 codex fix). Earlier revisions
   * cast `now::date` inside SQL — that evaluated in the DB session
   * timezone (typically UTC), so a 03:00 Almaty cron tick was still
   * "yesterday" in UTC and silently skipped invoices due that very day.
   * Computing the local calendar date in JS via `formatDateInTimezone`
   * removes the implicit dependency on PG session timezone.
   *
   * Re-running the same cron tick is idempotent: rows already in
   * `overdue` are filtered out by the status guard.
   *
   * Default no-op so existing in-memory fakes compile without an
   * explicit override; relational impl overrides with the real batch.
   */
  markOverdueBatch(
    _kindergartenId: string,
    _today: string,
    _now: Date,
  ): Promise<
    Array<{
      id: string;
      childId: string;
      amountAfterDiscount: number;
      dueDate: string;
    }>
  > {
    return Promise.resolve([]);
  }

  // ── B21 T3 ProRataRefundProcessor helpers ─────────────────────────────

  /**
   * Returns the single invoice (or null) for `childId` whose
   * `[period_start, period_end]` window contains `atDate` AND whose
   * status is one of pending|partial|overdue (i.e. has any remaining
   * billed amount the pro-rata refund could compensate). If multiple
   * rows match — rare unless a manual adjustment was inserted — the
   * latest `period_start DESC` wins.
   *
   * Default no-op so older fakes compile; relational impl overrides.
   */
  findCurrentInvoiceForChildAt(
    _kindergartenId: string,
    _childId: string,
    _atDate: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
}
