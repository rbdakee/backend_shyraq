import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { NotificationPort } from '@/common/notifications/notification.port';
import { tenantStorage } from '@/database/tenant-storage';
import {
  CreateCustomDiscountApplicationInput,
  CustomDiscountApplicationRepository,
  CustomDiscountApplicationStats,
} from './custom-discount-application.repository';
import {
  CreateCustomDiscountInput,
  CustomDiscountPageRequest,
  CustomDiscountRepository,
  ListCustomDiscountsFilter,
  UpdateCustomDiscountPatch,
} from './custom-discount.repository';
import {
  CustomDiscount,
  CustomDiscountStatus,
  CustomDiscountTargetType,
  CustomDiscountType,
  LocalisedText,
} from './domain/entities/custom-discount.entity';
import { CustomDiscountApplication } from './domain/entities/custom-discount-application.entity';
import { ConditionsRoot } from './domain/discount-conditions/conditions-evaluator';
import { CustomDiscountNotFoundError } from './domain/errors/custom-discount-not-found.error';
import { CustomDiscountStatusInvalidError } from './domain/errors/custom-discount-status-invalid.error';
import { CustomDiscountTargetInvalidError } from './domain/errors/custom-discount-target-invalid.error';
import { DiscountTargetResolver } from './discount-target-resolver';

/**
 * Service-level input for `CustomDiscountService.create`. Mirrors the
 * domain shape with admin-friendly defaults (priority=100, stackable=false,
 * notify_on_activation=true).
 */
export interface CreateCustomDiscountServiceInput {
  name: LocalisedText;
  description?: LocalisedText | null;
  discountType: CustomDiscountType;
  amount: number;
  conditions: ConditionsRoot;
  targetType: CustomDiscountTargetType;
  targetIds?: string[] | null;
  validFrom: Date;
  validUntil?: Date | null;
  maxUsesPerChild?: number | null;
  totalMaxUses?: number | null;
  priority?: number;
  stackable?: boolean;
  notifyOnActivation?: boolean;
  notificationTitle?: LocalisedText | null;
  notificationBody?: LocalisedText | null;
}

export type UpdateCustomDiscountServiceInput = UpdateCustomDiscountPatch;

export interface ListCustomDiscountsResult {
  rows: CustomDiscount[];
  total: number;
}

export interface CustomDiscountWithStats {
  discount: CustomDiscount;
  stats: CustomDiscountApplicationStats;
}

/**
 * CustomDiscountService — admin CRUD + state machine for the B16
 * custom-discount catalogue (§4.1 Custom Discounts in BP).
 *
 * State machine (delegated to `CustomDiscount` aggregate, but enforced
 * here at the persistence-edge via the conditional-UPDATE-WHERE-status
 * pattern + advisory lock for `activate`):
 *
 *   draft   ──activate──►  active
 *   active  ──pause──►     paused
 *   paused  ──resume──►    active
 *   {draft|active|paused}  ──cancel──►       cancelled
 *   active  ──expireOverdue──► expired   (silent, no notification)
 *
 * Activation flow (conflict-safe under concurrent admin clicks):
 *   1. Open ambient TX via `dataSource.transaction`.
 *   2. Acquire `pg_advisory_xact_lock` keyed on
 *      `discount:activation:{kg}:{id}` so concurrent activate() calls
 *      serialise.
 *   3. Re-check status under FOR UPDATE.
 *   4. Conditional `transitionStatus('draft' → 'active')` — 0 rows →
 *      throw `CustomDiscountStatusInvalidError`.
 *   5. If `notifyOnActivation`:
 *        - resolve target child ids via `DiscountTargetResolver`
 *        - emit `discount.activated` outbox event in the SAME TX so the
 *          rollback is atomic (target resolver throws → TX rolls back,
 *          status stays draft).
 *
 * BP §4.1: the expire flow is silent (no notification on `active →
 * expired`). Only `activate` produces a parent ping.
 *
 * `update` only succeeds when status='draft' — once activated, the
 * catalogue row is frozen except for state transitions.
 */
@Injectable()
export class CustomDiscountService {
  private readonly logger = new Logger(CustomDiscountService.name);

  constructor(
    private readonly customDiscounts: CustomDiscountRepository,
    private readonly customDiscountApplications: CustomDiscountApplicationRepository,
    private readonly notificationPort: NotificationPort,
    private readonly dataSource: DataSource,
    private readonly targetResolver: DiscountTargetResolver,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────

  /**
   * Create a new draft discount. The `CustomDiscount` aggregate ctor runs
   * all schema validations (`validateConditionsSchema`, target shape,
   * amount/validity invariants) so callers get domain-level errors before
   * the row hits the DB.
   *
   * Targeting validation against the kg's actual children/groups/tariff
   * plans is deferred to `DiscountTargetResolver.validateTarget`. We do
   * NOT check IDs at create-time inside this service to keep the surface
   * narrow — admins can fix typos via `update` while the row is still
   * draft.
   */
  async create(
    kindergartenId: string,
    input: CreateCustomDiscountServiceInput,
    createdBy: string | null,
  ): Promise<CustomDiscount> {
    const repoInput: CreateCustomDiscountInput = {
      kindergartenId,
      name: input.name,
      description: input.description ?? null,
      discountType: input.discountType,
      amount: input.amount,
      conditions: input.conditions,
      targetType: input.targetType,
      targetIds: input.targetIds ?? null,
      validFrom: input.validFrom,
      validUntil: input.validUntil ?? null,
      maxUsesPerChild: input.maxUsesPerChild ?? null,
      totalMaxUses: input.totalMaxUses ?? null,
      priority: input.priority ?? 100,
      stackable: input.stackable ?? false,
      notifyOnActivation: input.notifyOnActivation ?? true,
      notificationTitle: input.notificationTitle ?? null,
      notificationBody: input.notificationBody ?? null,
      createdBy,
    };
    // Validate inputs by hydrating a transient aggregate — this throws
    // domain errors (`CustomDiscountConditionsInvalidError`, target rules,
    // amount/validity) before we burn an INSERT. The aggregate handles
    // the JSONB normalisation; we then pass the typed value to repo.
    const transientNow = this.clock.now();
    CustomDiscount.fromState({
      id: '00000000-0000-0000-0000-000000000000',
      kindergartenId,
      name: repoInput.name,
      description: repoInput.description,
      discountType: repoInput.discountType,
      amount: MoneyKzt.fromKzt(repoInput.amount),
      conditions: repoInput.conditions,
      targetType: repoInput.targetType,
      targetIds: repoInput.targetIds,
      validFrom: repoInput.validFrom,
      validUntil: repoInput.validUntil,
      maxUsesPerChild: repoInput.maxUsesPerChild,
      totalMaxUses: repoInput.totalMaxUses,
      usedCount: 0,
      priority: repoInput.priority,
      stackable: repoInput.stackable,
      notifyOnActivation: repoInput.notifyOnActivation,
      notificationTitle: repoInput.notificationTitle,
      notificationBody: repoInput.notificationBody,
      status: 'draft',
      createdBy: repoInput.createdBy,
      createdAt: transientNow,
      updatedAt: transientNow,
    });
    return this.customDiscounts.create(repoInput);
  }

  /**
   * Patch a draft discount. Conditional UPDATE WHERE status='draft' so
   * concurrent activate→update races land cleanly: the activate winner
   * flips to active, the update sees 0 rows, raises
   * `CustomDiscountStatusInvalidError`.
   *
   * Re-validates conditions + target shape if either is in the patch by
   * hydrating a transient aggregate against the merged state.
   */
  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateCustomDiscountServiceInput,
  ): Promise<CustomDiscount> {
    const existing = await this.customDiscounts.findById(kindergartenId, id);
    if (!existing) {
      throw new CustomDiscountNotFoundError(id);
    }
    if (existing.status !== 'draft') {
      throw new CustomDiscountStatusInvalidError(existing.status, 'update');
    }
    if (
      patch.conditions !== undefined ||
      patch.targetType !== undefined ||
      patch.targetIds !== undefined ||
      patch.amount !== undefined ||
      patch.validFrom !== undefined ||
      patch.validUntil !== undefined
    ) {
      const merged = existing.toState();
      // Re-hydrate a transient aggregate to re-validate invariants.
      CustomDiscount.fromState({
        ...merged,
        name: patch.name ?? merged.name,
        description:
          patch.description !== undefined
            ? patch.description
            : merged.description,
        discountType: patch.discountType ?? merged.discountType,
        amount:
          patch.amount !== undefined
            ? MoneyKzt.fromKzt(patch.amount)
            : merged.amount,
        conditions: patch.conditions ?? merged.conditions,
        targetType: patch.targetType ?? merged.targetType,
        targetIds:
          patch.targetIds !== undefined ? patch.targetIds : merged.targetIds,
        validFrom: patch.validFrom ?? merged.validFrom,
        validUntil:
          patch.validUntil !== undefined ? patch.validUntil : merged.validUntil,
      });
    }
    const updated = await this.customDiscounts.update(
      kindergartenId,
      id,
      patch,
      'draft',
    );
    if (!updated) {
      // Raced against a concurrent state transition — re-read for accurate
      // error code.
      const fresh = await this.customDiscounts.findById(kindergartenId, id);
      if (!fresh) throw new CustomDiscountNotFoundError(id);
      throw new CustomDiscountStatusInvalidError(fresh.status, 'update');
    }
    return updated;
  }

  /**
   * `draft → active`. Acquires advisory lock + does conditional flip
   * inside an ambient TX. On `notifyOnActivation`, also fans out the
   * `discount.activated` event in the same TX — atomic with the
   * status flip.
   */
  async activate(kindergartenId: string, id: string): Promise<CustomDiscount> {
    const now = this.clock.now();
    return this.dataSource.transaction(async (em) => {
      // Set the kg-scoped GUC so RLS-correct queries flow through repos
      // that resolve their EM via tenantStorage. Also publish to
      // tenantStorage so repos see the same EM as the explicit `manager`
      // we pass below.
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        async () => {
          await this.customDiscounts.acquireDiscountActivationAdvisoryLock(
            kindergartenId,
            id,
            em,
          );
          const locked = await this.customDiscounts.findByIdForUpdate(
            kindergartenId,
            id,
            em,
          );
          if (!locked) {
            throw new CustomDiscountNotFoundError(id);
          }
          if (locked.status !== 'draft') {
            throw new CustomDiscountStatusInvalidError(
              locked.status,
              'activate',
            );
          }
          const flipped = await this.customDiscounts.transitionStatus(
            kindergartenId,
            id,
            'draft',
            'active',
            now,
            em,
          );
          if (!flipped) {
            // Should be unreachable — we hold FOR UPDATE row lock. Defensive.
            throw new CustomDiscountStatusInvalidError(
              locked.status,
              'activate',
            );
          }
          if (
            flipped.notifyOnActivation &&
            flipped.notificationTitle !== null &&
            flipped.notificationBody !== null
          ) {
            const targetChildIds =
              await this.targetResolver.resolveTargetChildIds(
                kindergartenId,
                flipped,
              );
            if (targetChildIds.size > 0) {
              await this.notificationPort.notifyDiscountActivated({
                kindergartenId,
                discountId: flipped.id,
                discountName: flipped.name,
                targetChildIds: Array.from(targetChildIds),
                notificationTitle: flipped.notificationTitle,
                notificationBody: flipped.notificationBody,
              });
            } else {
              this.logger.debug(
                `discount ${id} activated with notify_on_activation=true but resolved 0 target children — outbox skipped`,
              );
            }
          }
          return flipped;
        },
      );
    });
  }

  async pause(kindergartenId: string, id: string): Promise<CustomDiscount> {
    return this.simpleTransition(
      kindergartenId,
      id,
      'active',
      'paused',
      'pause',
    );
  }

  async resume(kindergartenId: string, id: string): Promise<CustomDiscount> {
    return this.simpleTransition(
      kindergartenId,
      id,
      'paused',
      'active',
      'resume',
    );
  }

  async cancel(kindergartenId: string, id: string): Promise<CustomDiscount> {
    const now = this.clock.now();
    const flipped = await this.customDiscounts.transitionStatus(
      kindergartenId,
      id,
      ['draft', 'active', 'paused'],
      'cancelled',
      now,
    );
    if (!flipped) {
      const fresh = await this.customDiscounts.findById(kindergartenId, id);
      if (!fresh) throw new CustomDiscountNotFoundError(id);
      throw new CustomDiscountStatusInvalidError(fresh.status, 'cancel');
    }
    return flipped;
  }

  /**
   * Bulk `active → expired` for rows whose validity window has passed.
   * Used by `DiscountExpireProcessor`. Idempotent (single-statement
   * UPDATE). BP §4.1: silent — no notification emit.
   */
  async expireOverdue(
    kindergartenId: string,
    now: Date,
  ): Promise<{ expiredIds: string[] }> {
    const result = await this.customDiscounts.markExpiredBatch(
      kindergartenId,
      now,
    );
    if (result.rowCount > 0) {
      this.logger.log(
        `custom-discount expire: kg=${kindergartenId} count=${result.rowCount} ids=${result.rowIds.join(',')}`,
      );
    }
    return { expiredIds: result.rowIds };
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async list(
    kindergartenId: string,
    filter: ListCustomDiscountsFilter,
    pagination: CustomDiscountPageRequest,
  ): Promise<ListCustomDiscountsResult> {
    return this.customDiscounts.list(kindergartenId, filter, pagination);
  }

  /**
   * Detail view: hydrates the discount + its application stats. The
   * stats query is a fast aggregate on the indexed `(child_id,
   * custom_discount_id)` pair so it's safe to inline here.
   */
  async getById(
    kindergartenId: string,
    id: string,
  ): Promise<CustomDiscountWithStats> {
    const discount = await this.customDiscounts.findById(kindergartenId, id);
    if (!discount) {
      throw new CustomDiscountNotFoundError(id);
    }
    const stats = await this.customDiscountApplications.getStatsForDiscount(
      kindergartenId,
      id,
    );
    return { discount, stats };
  }

  async listApplications(
    kindergartenId: string,
    id: string,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscountApplication[]; total: number }> {
    // Verify the parent discount exists in this tenant before listing —
    // an unknown id should surface 404 instead of an empty page.
    const discount = await this.customDiscounts.findById(kindergartenId, id);
    if (!discount) {
      throw new CustomDiscountNotFoundError(id);
    }
    return this.customDiscountApplications.listByDiscountId(
      kindergartenId,
      id,
      pagination,
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async simpleTransition(
    kindergartenId: string,
    id: string,
    fromStatus: CustomDiscountStatus,
    toStatus: CustomDiscountStatus,
    op: string,
  ): Promise<CustomDiscount> {
    const now = this.clock.now();
    const flipped = await this.customDiscounts.transitionStatus(
      kindergartenId,
      id,
      fromStatus,
      toStatus,
      now,
    );
    if (!flipped) {
      const fresh = await this.customDiscounts.findById(kindergartenId, id);
      if (!fresh) throw new CustomDiscountNotFoundError(id);
      throw new CustomDiscountStatusInvalidError(fresh.status, op);
    }
    return flipped;
  }
}

// Re-exports for service-spec convenience.
export type {
  CreateCustomDiscountApplicationInput,
  ListCustomDiscountsFilter,
  CustomDiscountPageRequest,
  CustomDiscountTargetInvalidError,
};
