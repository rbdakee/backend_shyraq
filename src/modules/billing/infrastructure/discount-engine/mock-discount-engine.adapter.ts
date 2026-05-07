import { Injectable, Logger } from '@nestjs/common';
import {
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './discount-engine.port';

interface AppliedRule {
  pct: number;
  reason: string;
  rule: string;
}

/**
 * MockDiscountEngine — B13 default. Implements only the two rule families
 * declared on `tariff_plans.discount_rules`:
 *
 *   1. Sibling discount — applied when `context.siblingsCount > 1` and
 *      `discount_rules.sibling_discount_pct` is set.
 *   2. Prepay discount — applied when `context.prepaymentMonths` matches a
 *      configured `prepay_<n>m_pct` key.
 *
 * Stacking is intentionally additive (capped at 100) — B16 will replace the
 * implementation with priority-based stacking once the discount-rules table
 * is in place. Custom discounts are out of scope for B13.
 */
@Injectable()
export class MockDiscountEngine extends DiscountEnginePort {
  private readonly logger = new Logger('MockDiscountEngine');

  evaluate(input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    const rules = input.tariffPlan.discountRules ?? {};
    const applied: AppliedRule[] = [];

    if (
      input.context.siblingsCount !== undefined &&
      input.context.siblingsCount > 1 &&
      typeof rules.sibling_discount_pct === 'number' &&
      rules.sibling_discount_pct > 0
    ) {
      applied.push({
        pct: rules.sibling_discount_pct,
        reason: 'sibling_discount',
        rule: 'sibling',
      });
    }

    if (input.context.prepaymentMonths !== undefined) {
      const months = input.context.prepaymentMonths;
      const key = `prepay_${months}m_pct` as keyof typeof rules;
      const pct = rules[key];
      if (typeof pct === 'number' && pct > 0) {
        applied.push({
          pct,
          reason: `prepay_${months}m`,
          rule: `prepay_${months}m`,
        });
      }
    }

    if (applied.length === 0) {
      return Promise.resolve({
        discountPct: null,
        discountReason: null,
        appliedRules: [],
      });
    }

    const totalPct = Math.min(
      100,
      applied.reduce((sum, x) => sum + x.pct, 0),
    );
    const result: DiscountEvaluationResult = {
      discountPct: totalPct,
      discountReason: applied.map((p) => p.reason).join(','),
      appliedRules: applied.map((p) => p.rule),
    };
    this.logger.debug(
      `[MockDiscount] invoice=${input.invoice.invoiceId} → ${result.discountPct}% (${result.discountReason})`,
    );
    return Promise.resolve(result);
  }
}
