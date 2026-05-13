import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  DiscountRules,
  TariffPlan,
} from '../../domain/entities/tariff-plan.entity';
import { Invoice, InvoiceType } from '../../domain/entities/invoice.entity';
import { PaymentProvider } from '../../domain/entities/payment.entity';
import {
  BenefitCategory,
  ConditionsRoot,
  PaymentMethodCode,
} from '../../domain/discount-conditions/conditions-evaluator';
import {
  CustomDiscountTargetType,
  CustomDiscountType,
  LocalisedText,
} from '../../domain/entities/custom-discount.entity';

/**
 * DiscountEnginePort — pluggable discount evaluator. The default Mock impl
 * (B13) handles sibling + prepay rules from `tariff_plans.discount_rules`.
 * B16 extends the same port with custom-discount handling: the InvoiceService
 * pre-loads the kg's currently-active custom discounts (filtered by
 * targeting + per-child usage caps) and passes them as
 * `context.customDiscounts`. The engine evaluates each one's `conditions`
 * AST against `childContext + familyContext + invoice + payment`, then
 * applies stacking + priority rules to produce a single combined
 * percentage / fixed-amount discount on the invoice.
 *
 * Targeting is resolved by `InvoiceService` (via `DiscountTargetResolver`)
 * BEFORE the engine call — the engine assumes every entry in
 * `context.customDiscounts` is already eligible for the child being
 * billed. This keeps the engine pure (no repo deps) and lets the service
 * cache the resolver lookup across multiple discounts.
 *
 * The port works with primitive snapshots (not domain objects directly) so
 * the engine is callable from both the live invoice-generation flow (where
 * an `Invoice` aggregate already exists) and from preview endpoints
 * (`POST /parent/invoices/:id/pay/prepayment`) where we only have a draft.
 */
export interface DiscountEvaluationInput {
  invoice: {
    invoiceId: string;
    invoiceType: InvoiceType;
    childId: string;
    kindergartenId: string;
    amountDue: MoneyKzt;
    periodStart: Date;
    periodEnd: Date;
    /** Snapshot of `due_date` — used by `early_payment` evaluator. */
    dueDate?: Date;
  };
  tariffPlan: {
    id: string;
    discountRules: DiscountRules;
  };
  context: {
    /** B13 sibling-rule input. Deprecated in favour of `familyContext.siblingsInKgCount`; kept for back-compat. */
    siblingsCount?: number;
    isFirstPayment?: boolean;
    paymentMethod?: PaymentProvider;
    prepaymentMonths?: number;
    /**
     * B16: catalogue snapshots pre-filtered to the (child, now) tuple.
     * Targeting + per-child usage caps + total_max_uses guard happen in
     * `InvoiceService` BEFORE the call — the engine just runs the
     * conditions AST + stacks/priorities.
     */
    customDiscounts?: CustomDiscountSnapshot[];
    /** B16: child-shape input for the conditions evaluator. */
    childContext?: ChildContext;
    /** B16: family-shape input for the conditions evaluator. */
    familyContext?: FamilyContext;
    /**
     * B16 optional payment-extension input — populated by the parent-app
     * prepay flow when the user has chosen a payment method up-front.
     */
    paymentMethodCode?: PaymentMethodCode;
    /** Days the parent paid before the invoice's due_date (early_payment cond). */
    paidEarlyDays?: number;
  };
}

/** B16 — minimal snapshot the engine needs to evaluate + stack a custom discount. */
export interface CustomDiscountSnapshot {
  id: string;
  name: LocalisedText;
  discountType: CustomDiscountType;
  amount: MoneyKzt;
  conditions: ConditionsRoot;
  targetType: CustomDiscountTargetType;
  targetIds: string[] | null;
  priority: number;
  stackable: boolean;
  maxUsesPerChild: number | null;
  totalMaxUses: number | null;
  usedCount: number;
  /**
   * Tie-breaker for `priority DESC, createdAt ASC` ordering (older row
   * wins on tie). Service passes this verbatim from the row.
   */
  createdAt: Date;
}

export interface ChildContext {
  birthDate: Date;
  ageInMonths: number;
  currentGroupId: string | null;
  benefitCategory: BenefitCategory | null;
}

export interface FamilyContext {
  siblingsInKgCount: number;
  isFirstInvoiceForChild: boolean;
}

export interface DiscountEvaluationResult {
  /** 0–100 inclusive when applicable; null when no rules matched. */
  discountPct: number | null;
  /** Human-readable, comma-joined when stacked. e.g. `'sibling_discount,prepay_12m,Custom: New Year 2026'`. */
  discountReason: string | null;
  /** Rule IDs that contributed (audit trail). Custom rules surface as `custom:<id>`. */
  appliedRules: string[];
  /**
   * B16 — applied custom-discount rows that the service should INSERT into
   * `custom_discount_applications`. Empty array when no custom rules
   * matched. The line-item write happens in the service (one combined
   * negative line item is the documented B16 trade-off).
   */
  customApplicationsToWrite: Array<{
    customDiscountId: string;
    amountApplied: number;
    /** Discount name (ru fallback) — stored in line-item description for audit. */
    reason: string;
  }>;
  /**
   * B16 T8 SO-1 — absolute KZT total of stacked custom-discount amounts.
   * `Invoice.computeAmountAfterDiscount` PREFERS this absolute value over
   * the round-tripped `discountPct` so percentage-bearing custom amounts
   * (e.g. fixed_amount = 3333 KZT on a 100000 invoice) survive without
   * rounding loss (3333 → 3.33% → 3330 lossy round trip). When `null`
   * (only sibling/prepay percentage rules matched), callers fall back to
   * `discountPct` exactly as in B13.
   */
  customDiscountAmount: number | null;
}

export abstract class DiscountEnginePort {
  abstract evaluate(
    input: DiscountEvaluationInput,
  ): Promise<DiscountEvaluationResult>;
}

// Re-export domain types used in the input shape so consumers don't have to
// reach into `domain/entities/*` for types tied to the evaluation contract.
export type { Invoice, TariffPlan };
