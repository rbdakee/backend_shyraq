import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from '../../../../domain/entities/payment.entity';
import { PaymentIdempotencyConflictError } from '../../../../domain/errors/payment-idempotency-conflict.error';
import {
  ListPaymentsFilter,
  PaymentRepository,
} from '../../payment.repository';
import { PaymentTypeOrmEntity } from '../entities/payment.typeorm.entity';
import { PaymentMapper } from '../mappers/payment.mapper';

const IDEMPOTENCY_CONSTRAINT = 'uq_payments_idempotency_key';

/**
 * Relational impl of `PaymentRepository`. T3 carried only the advisory
 * lock; T5a fills in the full CRUD + state-flip surface.
 *
 * Manager resolution:
 *   - Tenant-scoped methods (everything except
 *     `findByProviderTxnIdCrossTenant`) read the ambient EntityManager
 *     from `tenantStorage` so the per-request `SET LOCAL
 *     app.kindergarten_id` GUC remains in effect for RLS.
 *   - `findByProviderTxnIdCrossTenant` deliberately opens a fresh TX via
 *     `dataSource.transaction()` and pins `app.bypass_rls='true'` to it.
 *     This is the only way to look up a payment without the caller's
 *     tenant context (webhook arrives unauthenticated). Doing the same
 *     with `SET LOCAL` on the ambient TX would leak the bypass into the
 *     surrounding HTTP request — see B10 T7-2 HIGH#2.
 */
@Injectable()
export class PaymentRelationalRepository extends PaymentRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PaymentTypeOrmEntity)
    private readonly repo: Repository<PaymentTypeOrmEntity>,
  ) {
    super();
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  /**
   * `pg_advisory_xact_lock(hashtext('billing:payment:'||kgId||':'||invoiceId)::bigint)`.
   * Released on TX commit / rollback. Goes through `manager()` so it
   * inherits the ambient TX from `TenantContextInterceptor` (parent-pay
   * path) or the per-event TX of the webhook controller (T5a).
   *
   * ───────────────────────────────────────────────────────────────────────
   * Canonical M11 note (B22a) — applies to ALL `pg_advisory_xact_lock`
   * call-sites in the repo (~13 across billing/content/identity-qr/meal/
   * pickup/child).
   *
   * `hashtext(text)` returns `int` (32-bit signed). Postgres'
   * `pg_advisory_xact_lock(bigint)` expects 64-bit. Postgres auto-casts
   * `int → bigint` so the bare call is functionally correct, but the
   * explicit `::bigint` cast:
   *   1. Disambiguates the function-resolution at parse time (no risk of
   *      future overload-introduction breaking us silently).
   *   2. Documents at the call-site that we accept the 32-bit collision
   *      space of hashtext (≈ 1 in 4 billion). For our keyspace shapes —
   *      `'billing:payment:'||kg||':'||invoiceId` etc. — collision
   *      probability is negligible (max ~10^4 distinct keys per minute
   *      kingdom-wide; birthday-paradox bound puts P(collision) below
   *      10^-7 over a single business day). Accepted trade-off vs the
   *      cost of a content-addressed lock-table or a dedicated
   *      `bigint(text)` extension.
   *   3. Lint-safety: a future `hashtextextended` (64-bit) migration would
   *      keep working with the cast in place.
   * Functional change of adding `::bigint` is zero — kept as
   * documentation + future-proofing only.
   * ───────────────────────────────────────────────────────────────────────
   */
  async acquirePaymentAdvisoryLock(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<void> {
    const scope = `billing:payment:${kindergartenId}:${invoiceId}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  async create(payment: Payment, explicit?: EntityManager): Promise<Payment> {
    const m = this.manager(explicit);
    const s = payment.toState();
    // Wrap the INSERT in a SAVEPOINT (TypeORM nested-transaction = SAVEPOINT
    // on the same connection) so a 23505 idempotency conflict only rolls
    // back the inner statement — not the surrounding business TX. Without
    // this the per-request TX is poisoned (`current transaction is aborted`)
    // and the service's idempotency-conflict re-read query fails.
    try {
      await m.transaction(async (savepoint) => {
        await savepoint.getRepository(PaymentTypeOrmEntity).insert({
          id: s.id,
          kindergartenId: s.kindergartenId,
          invoiceId: s.invoiceId,
          childId: s.childId,
          payerUserId: s.payerUserId,
          amount: s.amount,
          provider: s.provider,
          providerTxnId: s.providerTxnId,
          idempotencyKey: s.idempotencyKey,
          status: s.status,
          // jsonb — TypeORM QueryDeepPartial requires a cast.
          providerPayload: s.providerPayload as unknown as undefined,
          paidAt: s.paidAt,
          refundId: s.refundId,
          reconciliationAttempts: s.reconciliationAttempts ?? 0,
          lastReconciledAt: s.lastReconciledAt ?? null,
          nextReconciliationAt: s.nextReconciliationAt ?? null,
          manualReviewRequiredAt: s.manualReviewRequiredAt ?? null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        });
      });
      return payment;
    } catch (err) {
      if (
        err instanceof QueryFailedError &&
        isUniqueViolation(err) &&
        constraintNameOf(err).includes(IDEMPOTENCY_CONSTRAINT)
      ) {
        throw new PaymentIdempotencyConflictError(s.idempotencyKey);
      }
      throw err;
    }
  }

  async findById(kindergartenId: string, id: string): Promise<Payment | null> {
    const row = await this.manager()
      .getRepository(PaymentTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  async findByIdempotencyKey(
    kindergartenId: string,
    idempotencyKey: string,
  ): Promise<Payment | null> {
    const row = await this.manager()
      .getRepository(PaymentTypeOrmEntity)
      .findOne({ where: { kindergartenId, idempotencyKey } });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  async findByInvoiceId(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<Payment[]> {
    const rows = await this.manager()
      .getRepository(PaymentTypeOrmEntity)
      .find({
        where: { kindergartenId, invoiceId },
        order: { createdAt: 'DESC' },
      });
    return rows.map(PaymentMapper.toDomain);
  }

  async findByProviderTxnId(
    kindergartenId: string,
    provider: PaymentProvider,
    providerTxnId: string,
  ): Promise<Payment | null> {
    const row = await this.manager()
      .getRepository(PaymentTypeOrmEntity)
      .findOne({ where: { kindergartenId, provider, providerTxnId } });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListPaymentsFilter = {},
  ): Promise<Payment[]> {
    const qb = this.manager()
      .getRepository(PaymentTypeOrmEntity)
      .createQueryBuilder('p')
      .where('p.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.provider) {
      qb.andWhere('p.provider = :provider', { provider: filter.provider });
    }
    if (filter.status) {
      qb.andWhere('p.status = :status', { status: filter.status });
    }
    if (filter.childId) {
      qb.andWhere('p.child_id = :child', { child: filter.childId });
    }
    if (filter.invoiceId) {
      qb.andWhere('p.invoice_id = :invoice', { invoice: filter.invoiceId });
    }
    if (filter.refundRequired) {
      qb.andWhere('p.refund_required = true');
    }
    if (filter.fromDate) {
      qb.andWhere('p.created_at >= :from', { from: filter.fromDate });
    }
    if (filter.toDate) {
      qb.andWhere('p.created_at <= :to', { to: filter.toDate });
    }
    qb.orderBy('p.created_at', 'DESC').addOrderBy('p.id', 'DESC');

    const rows = await qb.getMany();
    return rows.map(PaymentMapper.toDomain);
  }

  /**
   * Webhook entry point — the kg context is unknown until we resolve the
   * payment by its provider-side identifier. Opens a dedicated TX so the
   * `app.bypass_rls` SET LOCAL is scoped to exactly this lookup; the
   * ambient TX (if any) is not affected.
   */
  async findByProviderTxnIdCrossTenant(
    provider: PaymentProvider,
    providerTxnId: string,
  ): Promise<Payment | null> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const row = await em.getRepository(PaymentTypeOrmEntity).findOne({
        where: { provider, providerTxnId },
      });
      return row ? PaymentMapper.toDomain(row) : null;
    });
  }

  /**
   * Cross-tenant lookup by `(kindergartenId, id)` — the K8 Kaspi status poller
   * runs without an HTTP tenant context. Opens a dedicated TX so the
   * `app.bypass_rls` SET LOCAL is scoped to exactly this lookup and never
   * leaks into the ambient TX (mirrors `findByProviderTxnIdCrossTenant`).
   */
  async findByIdCrossTenant(
    kindergartenId: string,
    id: string,
  ): Promise<Payment | null> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const row = await em.getRepository(PaymentTypeOrmEntity).findOne({
        where: { id, kindergartenId },
      });
      return row ? PaymentMapper.toDomain(row) : null;
    });
  }

  async markCompletedConditional(
    kindergartenId: string,
    id: string,
    providerTxnId: string,
    paidAt: Date,
    providerPayload: Record<string, unknown> | null,
    now: Date,
  ): Promise<Payment | null> {
    return this.transitionConditional(
      kindergartenId,
      id,
      ['initiated', 'processing'],
      {
        status: 'completed',
        providerTxnId,
        paidAt,
        // jsonb — cast to satisfy TypeORM QueryDeepPartial.
        providerPayload: providerPayload as unknown as undefined,
        nextReconciliationAt: null,
        updatedAt: now,
      },
    );
  }

  async markFailedConditional(
    kindergartenId: string,
    id: string,
    failureReason: string,
    providerPayload: Record<string, unknown> | null,
    now: Date,
  ): Promise<Payment | null> {
    const mergedPayload = {
      ...(providerPayload ?? {}),
      failure_reason: failureReason,
    };
    return this.transitionConditional(
      kindergartenId,
      id,
      ['initiated', 'processing'],
      {
        status: 'failed',
        // jsonb — cast to satisfy TypeORM QueryDeepPartial.
        providerPayload: mergedPayload as unknown as undefined,
        nextReconciliationAt: null,
        updatedAt: now,
      },
    );
  }

  async updateProviderPayload(
    kindergartenId: string,
    id: string,
    providerPayload: Record<string, unknown>,
    now: Date,
  ): Promise<Payment | null> {
    const result = await this.manager()
      .createQueryBuilder()
      .update(PaymentTypeOrmEntity)
      .set({
        providerPayload: providerPayload as unknown as undefined,
        updatedAt: now,
      })
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .returning('*')
      .execute();
    if (!result.raw?.length) return null;
    return this.findById(kindergartenId, id);
  }

  async markProcessingConditional(
    kindergartenId: string,
    id: string,
    now: Date,
    providerTxnId?: string | null,
    providerPayload?: Record<string, unknown> | null,
  ): Promise<Payment | null> {
    const patch: Partial<PaymentTypeOrmEntity> = {
      status: 'processing',
      updatedAt: now,
    };
    if (providerTxnId != null) {
      patch.providerTxnId = providerTxnId;
    }
    if (providerPayload != null) {
      // Merge into the existing provider_payload (mirror markFailedConditional's
      // merge semantics) so previously-stashed hints are not clobbered.
      const current = await this.findById(kindergartenId, id);
      const mergedPayload = {
        ...(current?.providerPayload ?? {}),
        ...providerPayload,
      };
      // jsonb — cast to satisfy TypeORM QueryDeepPartial.
      patch.providerPayload = mergedPayload as unknown as undefined;
    }
    return this.transitionConditional(kindergartenId, id, ['initiated'], patch);
  }

  async markRefundedConditional(
    kindergartenId: string,
    id: string,
    refundId: string,
    now: Date,
  ): Promise<Payment | null> {
    return this.transitionConditional(kindergartenId, id, ['completed'], {
      status: 'refunded',
      refundId,
      updatedAt: now,
    });
  }

  async markRefundRequired(
    kindergartenId: string,
    id: string,
    reason: string,
    duplicateOfPaymentId: string,
    now: Date,
  ): Promise<Payment | null> {
    const m = this.manager();
    const result = await m
      .createQueryBuilder()
      .update(PaymentTypeOrmEntity)
      .set({
        refundRequired: true,
        refundReason: reason,
        duplicateOfPaymentId,
        updatedAt: now,
      })
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .returning('*')
      .execute();

    if (!result.raw?.length) {
      return null;
    }
    // Re-fetch to hydrate via the entity (raw rows are snake_case columns).
    const row = await m
      .getRepository(PaymentTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  async scheduleBccReconciliation(
    kindergartenId: string,
    id: string,
    nextAt: Date,
    now: Date,
  ): Promise<Payment | null> {
    const result = await this.manager()
      .createQueryBuilder()
      .update(PaymentTypeOrmEntity)
      .set({ nextReconciliationAt: nextAt, updatedAt: now })
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`provider = 'bcc'`)
      .andWhere(`status = 'processing'`)
      .andWhere('manual_review_required_at IS NULL')
      .returning('*')
      .execute();
    if (!result.raw?.length) return null;
    return this.findById(kindergartenId, id);
  }

  async claimBccReconciliationCrossTenant(
    kindergartenId: string,
    id: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<Payment | null> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const result = await em
        .createQueryBuilder()
        .update(PaymentTypeOrmEntity)
        .set({
          reconciliationAttempts: () => '"reconciliation_attempts" + 1',
          lastReconciledAt: now,
          nextReconciliationAt: leaseUntil,
          updatedAt: now,
        })
        .where('id = :id', { id })
        .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
        .andWhere(`provider = 'bcc'`)
        .andWhere(`status = 'processing'`)
        .andWhere('manual_review_required_at IS NULL')
        .andWhere('next_reconciliation_at IS NOT NULL')
        .andWhere('next_reconciliation_at <= :now', { now })
        .returning('*')
        .execute();
      if (!result.raw?.length) return null;
      const row = await em
        .getRepository(PaymentTypeOrmEntity)
        .findOne({ where: { id, kindergartenId } });
      return row ? PaymentMapper.toDomain(row) : null;
    });
  }

  async rescheduleBccReconciliationCrossTenant(
    kindergartenId: string,
    id: string,
    nextAt: Date,
    now: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const result = await em
        .createQueryBuilder()
        .update(PaymentTypeOrmEntity)
        .set({ nextReconciliationAt: nextAt, updatedAt: now })
        .where('id = :id', { id })
        .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
        .andWhere(`provider = 'bcc'`)
        .andWhere(`status = 'processing'`)
        .andWhere('manual_review_required_at IS NULL')
        .execute();
      return (result.affected ?? 0) === 1;
    });
  }

  async markBccManualReviewCrossTenant(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const result = await em
        .createQueryBuilder()
        .update(PaymentTypeOrmEntity)
        .set({
          manualReviewRequiredAt: now,
          nextReconciliationAt: null,
          updatedAt: now,
        })
        .where('id = :id', { id })
        .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
        .andWhere(`provider = 'bcc'`)
        .andWhere(`status = 'processing'`)
        .andWhere('manual_review_required_at IS NULL')
        .execute();
      return (result.affected ?? 0) === 1;
    });
  }

  /**
   * Conditional UPDATE: applies `patch` only if current row status is one
   * of `expected`. Returns the hydrated domain on success or `null` when
   * 0 rows matched. Mirrors `InvoiceRelationalRepository.transitionStatusConditional`
   * (db8cb72 pattern).
   */
  private async transitionConditional(
    kindergartenId: string,
    id: string,
    expected: PaymentStatus[],
    patch: Partial<PaymentTypeOrmEntity>,
  ): Promise<Payment | null> {
    const m = this.manager();
    const result = await m
      .createQueryBuilder()
      .update(PaymentTypeOrmEntity)
      .set(patch)
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('status IN (:...expected)', { expected })
      .returning('*')
      .execute();

    if (!result.raw?.length) {
      return null;
    }

    const row = await m
      .getRepository(PaymentTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? PaymentMapper.toDomain(row) : null;
  }

  // ── B-DASH — Dashboard revenue aggregate ──────────────────────────────

  async sumCompletedBetween(
    kindergartenId: string,
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<number> {
    const result = await this.manager().query(
      `SELECT COALESCE(SUM(amount), 0)::text AS amount
         FROM payments
        WHERE kindergarten_id = $1
          AND status = 'completed'
          AND paid_at >= $2
          AND paid_at < $3`,
      [kindergartenId, fromIso, toIsoExclusive],
    );
    return Number(result?.[0]?.amount ?? 0);
  }

  async aggregateByProviderBetween(
    kindergartenId: string,
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<Array<{ provider: string; count: number; amount: number }>> {
    const rows = await this.manager().query(
      `SELECT provider,
              COUNT(*)::text AS count,
              COALESCE(SUM(amount), 0)::text AS amount
         FROM payments
        WHERE kindergarten_id = $1
          AND status = 'completed'
          AND paid_at >= $2
          AND paid_at < $3
        GROUP BY provider
        ORDER BY provider`,
      [kindergartenId, fromIso, toIsoExclusive],
    );
    return (rows ?? []).map(
      (r: { provider: string; count: string; amount: string }) => ({
        provider: r.provider,
        count: Number(r.count ?? 0),
        amount: Number(r.amount ?? 0),
      }),
    );
  }
}

// ── error helpers ────────────────────────────────────────────────────────

interface PgDriverError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

function isUniqueViolation(err: QueryFailedError): boolean {
  const driverErr = (err as unknown as { driverError?: PgDriverError })
    .driverError;
  return driverErr?.code === '23505';
}

function constraintNameOf(err: QueryFailedError): string {
  const driverErr = (err as unknown as { driverError?: PgDriverError })
    .driverError;
  return driverErr?.constraint ?? driverErr?.detail ?? '';
}
