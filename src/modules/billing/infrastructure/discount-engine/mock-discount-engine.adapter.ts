import { Injectable, Logger } from '@nestjs/common';
import { roundKzt } from '@/shared-kernel/domain/money';
import {
  evaluateConditions,
  EvalContext,
} from '../../domain/discount-conditions/conditions-evaluator';
import {
  CustomDiscountSnapshot,
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './discount-engine.port';

interface BasicAppliedRule {
  pct: number;
  reason: string;
  rule: string;
}

interface AppliedCustom {
  snapshot: CustomDiscountSnapshot;
  amountApplied: number;
  reason: string;
}

/**
 * MockDiscountEngine — B13 default + B16 custom-discount extension.
 *
 * B13 rule families (unchanged):
 *   1. Sibling discount  — `context.familyContext.siblingsInKgCount > 1`
 *      (with `siblingsCount` legacy field as fallback) and
 *      `discount_rules.sibling_discount_pct` set.
 *   2. Prepay discount   — `context.prepaymentMonths` matches a
 *      configured `prepay_<n>m_pct` key.
 *   B13 stacking is additive (capped at 100); these rules continue to
 *   produce a `discountPct` field and write to `appliedRules` exactly as
 *   B13 callers expect.
 *
 * B16 custom rules (NEW):
 *   - For each `context.customDiscounts` entry, run `evaluateConditions`
 *     against an `EvalContext` built from `childContext + familyContext +
 *     invoice + payment`. Discounts whose conditions evaluate `false`
 *     are filtered out. Defensive log+skip if the AST throws (should be
 *     unreachable post-validateConditionsSchema).
 *   - Sort matched custom discounts by `priority DESC, createdAt ASC`.
 *   - Stacking (T8 H3 — corrected from T3 §E):
 *       * Sort by priority DESC, createdAt ASC.
 *       * If the FIRST (highest-priority) match is non-stackable, ONLY
 *         that one applies. (Top non-stackable wins outright.)
 *       * Otherwise (top is stackable), apply the contiguous stackable
 *         prefix. Stop at the first non-stackable encountered.
 *         Justification: a non-stackable mid-list acts as a gate — once
 *         hit, no further stacking — but higher-priority stackables that
 *         came before still apply (they "won" by priority).
 *   - Amount calculation: `percentage` → `amountDue * (amount/100)`;
 *     `fixed_amount` → `min(amount, remaining)` where `remaining =
 *     amountDue - alreadyStackedKzt`. Total cap = `amountDue`.
 *   - Returns `customApplicationsToWrite` so the service can persist the
 *     `custom_discount_applications` ledger rows.
 *   - T8 SO-1 fix: returns absolute `customDiscountAmount` (KZT) so
 *     downstream `Invoice.computeAmountAfterDiscount` can subtract the
 *     EXACT amount instead of round-tripping through a 2dp percentage
 *     (which loses precision on non-divisible totals like 3333/100000 →
 *     3.33% → 3330 ≠ 3333). The combined `discountPct` is still emitted
 *     for B13 backward-compat (presenter/audit trail), but the line-item
 *     amount derives from the absolute total.
 *
 * Targeting + per-child max-uses + total_max_uses caps are enforced
 * UPSTREAM in `InvoiceService` (passed-in snapshots are pre-filtered).
 * The engine assumes every snapshot in `context.customDiscounts` is
 * eligible for THIS child + invoice.
 */
@Injectable()
export class MockDiscountEngine extends DiscountEnginePort {
  private readonly logger = new Logger('MockDiscountEngine');

  evaluate(input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    const result = this.evaluateSync(input);
    return Promise.resolve(result);
  }

  private evaluateSync(
    input: DiscountEvaluationInput,
  ): DiscountEvaluationResult {
    const rules = input.tariffPlan.discountRules ?? {};
    const basic: BasicAppliedRule[] = [];

    // ── B13 sibling rule ────────────────────────────────────────────────
    // Prefer `familyContext.siblingsInKgCount` (B16 wiring); fall back to
    // the legacy `siblingsCount` field (B13 callers).
    const siblings =
      input.context.familyContext?.siblingsInKgCount ??
      input.context.siblingsCount;
    if (
      siblings !== undefined &&
      siblings > 1 &&
      typeof rules.sibling_discount_pct === 'number' &&
      rules.sibling_discount_pct > 0
    ) {
      basic.push({
        pct: rules.sibling_discount_pct,
        reason: 'sibling_discount',
        rule: 'sibling',
      });
    }

    // ── B13 prepay rule ─────────────────────────────────────────────────
    if (input.context.prepaymentMonths !== undefined) {
      const months = input.context.prepaymentMonths;
      const key = `prepay_${months}m_pct` as keyof typeof rules;
      const pct = rules[key];
      if (typeof pct === 'number' && pct > 0) {
        basic.push({
          pct,
          reason: `prepay_${months}m`,
          rule: `prepay_${months}m`,
        });
      }
    }

    // ── B16 custom-discount rules ───────────────────────────────────────
    const customMatches = this.matchCustomDiscounts(input);
    const customApplied = this.applyStackingAndAmounts(
      input.invoice.amountDue,
      customMatches,
    );

    if (basic.length === 0 && customApplied.length === 0) {
      return {
        discountPct: null,
        discountReason: null,
        appliedRules: [],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };
    }

    // Compute the basic-rule percentage (capped at 100).
    const basicPct = Math.min(
      100,
      basic.reduce((s, x) => s + x.pct, 0),
    );

    // Convert custom-applied KZT into an equivalent percentage of
    // `amountDue`. We expose ONE combined `discountPct` for the invoice
    // (preserving B13 backward-compat); custom-applications are emitted
    // separately via `customApplicationsToWrite` for the audit ledger.
    const customKzt = customApplied.reduce((s, x) => s + x.amountApplied, 0);
    const amountDue = input.invoice.amountDue;
    const customPct =
      amountDue > 0 ? roundKzt((customKzt / amountDue) * 100) : 0;

    // Combined cap at 100% — basic + custom never exceeds amountDue.
    const totalPct = Math.min(100, basicPct + customPct);

    const reasonParts: string[] = [];
    const appliedRuleIds: string[] = [];
    for (const b of basic) {
      reasonParts.push(b.reason);
      appliedRuleIds.push(b.rule);
    }
    for (const c of customApplied) {
      reasonParts.push(c.reason);
      appliedRuleIds.push(`custom:${c.snapshot.id}`);
    }

    const out: DiscountEvaluationResult = {
      discountPct: totalPct > 0 ? totalPct : null,
      discountReason: reasonParts.length > 0 ? reasonParts.join(',') : null,
      appliedRules: appliedRuleIds,
      customApplicationsToWrite: customApplied.map((c) => ({
        customDiscountId: c.snapshot.id,
        amountApplied: c.amountApplied,
        reason: c.reason,
      })),
      // T8 SO-1: keep the precise KZT total so the invoice line item
      // subtracts the exact amount (3333 not 3330). `null` when only
      // sibling/prepay basic-rules contributed — caller falls back to
      // discountPct (the B13 path).
      customDiscountAmount: customKzt > 0 ? customKzt : null,
    };
    this.logger.debug(
      `[MockDiscount] invoice=${input.invoice.invoiceId} → ${out.discountPct ?? 'null'}% (${
        out.discountReason ?? '-'
      }) — custom applications: ${out.customApplicationsToWrite.length}`,
    );
    return out;
  }

  private matchCustomDiscounts(
    input: DiscountEvaluationInput,
  ): CustomDiscountSnapshot[] {
    const customs = input.context.customDiscounts;
    if (!customs || customs.length === 0) return [];
    const ctx = this.buildEvalContext(input);
    if (ctx === null) {
      // No childContext / familyContext — engine cannot evaluate
      // conditions safely. Skip all custom discounts and warn.
      if (customs.length > 0) {
        this.logger.warn(
          `[MockDiscount] invoice=${input.invoice.invoiceId} has ${customs.length} custom discounts but no childContext/familyContext — skipping.`,
        );
      }
      return [];
    }

    const matches: CustomDiscountSnapshot[] = [];
    for (const snap of customs) {
      try {
        if (evaluateConditions(snap.conditions, ctx)) {
          matches.push(snap);
        }
      } catch (err) {
        this.logger.warn(
          `[MockDiscount] custom discount ${snap.id} evaluator threw: ${
            (err as Error).message
          } — skipping.`,
        );
      }
    }
    return matches;
  }

  private applyStackingAndAmounts(
    amountDue: number,
    matches: CustomDiscountSnapshot[],
  ): AppliedCustom[] {
    if (matches.length === 0) return [];

    // Sort by priority DESC, createdAt ASC.
    const sorted = [...matches].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // B16 stacking rule (T8 H3 — corrected from T3 §E):
    //   * If the TOP (highest-priority) match is non-stackable, ONLY
    //     that one applies — full block on stacking.
    //   * Otherwise (top is stackable), take the contiguous stackable
    //     prefix. Stop at the first non-stackable encountered (it acts
    //     as a gate — higher-priority stackables before it still apply,
    //     since they "won" by priority).
    //
    // Examples on `[A, B, C]` sorted high→low priority:
    //   A=NS              → winners=[A]
    //   A=S, B=NS, C=S    → winners=[A]  (gate at B; C trimmed)
    //   A=S, B=S, C=NS    → winners=[A, B]
    //   A=S, B=S, C=S     → winners=[A, B, C]
    //   A=NS, B=NS, C=NS  → winners=[A]
    let winners: CustomDiscountSnapshot[];
    if (!sorted[0].stackable) {
      winners = [sorted[0]];
    } else {
      winners = [];
      for (const s of sorted) {
        if (!s.stackable) break;
        winners.push(s);
      }
    }

    const applied: AppliedCustom[] = [];
    let alreadyStacked = 0;
    for (const snap of winners) {
      const remaining = amountDue - alreadyStacked;
      if (remaining <= 0) break;
      let amountApplied: number;
      if (snap.discountType === 'percentage') {
        amountApplied = roundKzt(amountDue * (snap.amount / 100));
      } else {
        // fixed_amount
        amountApplied = Math.min(snap.amount, remaining);
      }
      // Cap each individual at remaining so combined never exceeds amountDue.
      if (amountApplied > remaining) amountApplied = remaining;
      if (amountApplied <= 0) continue;
      const reason = snap.name.ru ?? Object.values(snap.name)[0] ?? snap.id;
      applied.push({ snapshot: snap, amountApplied, reason });
      alreadyStacked += amountApplied;
    }
    return applied;
  }

  private buildEvalContext(input: DiscountEvaluationInput): EvalContext | null {
    const child = input.context.childContext;
    const family = input.context.familyContext;
    if (!child || !family) return null;
    return {
      invoice: {
        invoiceType: input.invoice.invoiceType,
        periodStart: input.invoice.periodStart,
        periodEnd: input.invoice.periodEnd,
        amountDue: input.invoice.amountDue,
        dueDate: input.invoice.dueDate ?? input.invoice.periodEnd,
      },
      child: {
        id: input.invoice.childId,
        birthDate: child.birthDate,
        currentGroupId: child.currentGroupId,
        ageInMonths: child.ageInMonths,
        benefitCategory: child.benefitCategory,
      },
      family: {
        siblingsInKgCount: family.siblingsInKgCount,
        isFirstInvoiceForChild: family.isFirstInvoiceForChild,
      },
      payment: {
        method: input.context.paymentMethodCode,
        prepaymentMonths: input.context.prepaymentMonths,
        paidEarlyDays: input.context.paidEarlyDays,
      },
      now: input.invoice.periodStart,
    };
  }
}
