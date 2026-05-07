import type { InvoiceType } from '../entities/invoice.entity';
import { CustomDiscountConditionsInvalidError } from '../errors/custom-discount-conditions-invalid.error';

/**
 * B16 — Custom Discount conditions evaluator (pure function).
 *
 * Domain layer only — no NestJS, no I/O, no IO clocks. The schema below
 * is the canonical SoT for the JSONB shape stored in
 * `custom_discounts.conditions`.
 *
 * Empty `{}` is the catalogue default ("apply always within targeting +
 * status + valid_from/until") — it always evaluates to `true`. Composite
 * nodes (`all_of`, `any_of`) may nest up to depth 3 (root counts as 0;
 * deeper input throws `conditions_depth_limit_exceeded`).
 */

// ── Shared sub-types ──────────────────────────────────────────────────────

export type BenefitCategory =
  | 'multi_child'
  | 'disability'
  | 'single_mother'
  | 'mother_heroine';

/**
 * Payment method codes that can appear in a `payment_method` condition.
 *
 * NB: distinct from the broader `PaymentProvider` enum on the Payment
 * aggregate (`mock | halyk_epay | kaspi_pay | tiptoppay | freedom_pay |
 * cash`). The catalogue intentionally exposes a narrower, user-facing
 * set; extend deliberately when a new method becomes user-visible.
 */
export type PaymentMethodCode =
  | 'kaspi_pay'
  | 'halyk_epay'
  | 'cash'
  | 'bank_transfer';

/**
 * `tariff_types` condition input. Decision: matches the InvoiceType the
 * evaluator actually has in `EvalContext.invoice` (since invoices are
 * what get discounted), NOT the broader `TariffType` enum from
 * tariff-plan.entity. The latter has assignment-only values
 * (`additional_service`, `late_pickup_fee`) that flow into the same
 * InvoiceType set anyway, so the practical input set is identical.
 */
export type InvoiceTypeCode = InvoiceType;

// ── Condition AST ─────────────────────────────────────────────────────────

export type ComparisonOp = 'gte' | 'eq';

export type LeafCondition =
  | { type: 'prepayment_months'; op: ComparisonOp; value: number }
  | { type: 'siblings_count'; op: ComparisonOp; value: number }
  | { type: 'age_range'; from_months: number; to_months: number }
  | { type: 'benefit_category'; in: BenefitCategory[] }
  | { type: 'payment_method'; in: PaymentMethodCode[] }
  | { type: 'early_payment'; days_before_due: number }
  | { type: 'birthday_month' }
  | { type: 'date_range'; from: string; to: string }
  | { type: 'first_invoice' }
  | { type: 'tariff_types'; in: InvoiceTypeCode[] };

export type CompositeCondition =
  | { all_of: DiscountCondition[] }
  | { any_of: DiscountCondition[] };

export type DiscountCondition = LeafCondition | CompositeCondition;

/**
 * The catalogue-default (empty object) means "always matches".
 */
export type ConditionsRoot = DiscountCondition | Record<string, never>;

// ── EvalContext ───────────────────────────────────────────────────────────

export interface EvalContext {
  invoice: {
    invoiceType: InvoiceType;
    periodStart: Date;
    periodEnd: Date;
    amountDue: number;
    dueDate: Date;
  };
  child: {
    id: string;
    birthDate: Date;
    currentGroupId: string | null;
    ageInMonths: number;
    benefitCategory: BenefitCategory | null;
  };
  family: {
    siblingsInKgCount: number;
    isFirstInvoiceForChild: boolean;
  };
  payment: {
    method?: PaymentMethodCode;
    prepaymentMonths?: number;
    paidEarlyDays?: number;
  };
  now: Date;
}

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_DEPTH = 3;

const KNOWN_LEAF_TYPES: ReadonlySet<string> = new Set([
  'prepayment_months',
  'siblings_count',
  'age_range',
  'benefit_category',
  'payment_method',
  'early_payment',
  'birthday_month',
  'date_range',
  'first_invoice',
  'tariff_types',
]);

const KNOWN_COMPARISON_OPS: ReadonlySet<string> = new Set(['gte', 'eq']);

const KNOWN_BENEFIT_CATEGORIES: ReadonlySet<string> = new Set([
  'multi_child',
  'disability',
  'single_mother',
  'mother_heroine',
]);

const KNOWN_PAYMENT_METHODS: ReadonlySet<string> = new Set([
  'kaspi_pay',
  'halyk_epay',
  'cash',
  'bank_transfer',
]);

const KNOWN_INVOICE_TYPES: ReadonlySet<string> = new Set([
  'monthly',
  'prepayment_3m',
  'prepayment_6m',
  'prepayment_12m',
  'prepayment_24m',
  'additional_service',
  'late_pickup_fee',
  'other',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Schema validator ──────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNonNegInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Validate a `conditions` JSONB blob and return a typed `ConditionsRoot`.
 *
 * Empty `{}` returns `{}` (the "always matches" default). Otherwise the
 * input must be a recognisable composite or leaf node and every nested
 * field must satisfy the per-type schema. Throws
 * `CustomDiscountConditionsInvalidError` with a machine-readable
 * `details.reason` slug.
 */
export function validateConditionsSchema(conditions: unknown): ConditionsRoot {
  if (!isPlainObject(conditions)) {
    throw new CustomDiscountConditionsInvalidError('invalid_root_shape');
  }
  const keys = Object.keys(conditions);
  if (keys.length === 0) {
    return {};
  }
  return validateNode(conditions, 0, '$');
}

function validateNode(
  node: unknown,
  depth: number,
  path: string,
): DiscountCondition {
  if (depth > MAX_DEPTH) {
    throw new CustomDiscountConditionsInvalidError(
      'conditions_depth_limit_exceeded',
      path,
    );
  }
  if (!isPlainObject(node)) {
    throw new CustomDiscountConditionsInvalidError('invalid_root_shape', path);
  }

  if ('all_of' in node || 'any_of' in node) {
    const isAll = 'all_of' in node;
    const childKey = isAll ? 'all_of' : 'any_of';
    const children = (node as Record<string, unknown>)[childKey];
    if (!Array.isArray(children)) {
      throw new CustomDiscountConditionsInvalidError(
        'invalid_condition_field',
        `${path}.${childKey}`,
      );
    }
    const validated = children.map((c, i) =>
      validateNode(c, depth + 1, `${path}.${childKey}[${i}]`),
    );
    return isAll
      ? ({ all_of: validated } as CompositeCondition)
      : ({ any_of: validated } as CompositeCondition);
  }

  const type = (node as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_LEAF_TYPES.has(type)) {
    throw new CustomDiscountConditionsInvalidError(
      'unknown_condition_type',
      path,
    );
  }

  return validateLeaf(node as Record<string, unknown>, type, path);
}

function validateLeaf(
  node: Record<string, unknown>,
  type: string,
  path: string,
): LeafCondition {
  const fieldErr = (field: string): never => {
    throw new CustomDiscountConditionsInvalidError(
      'invalid_condition_field',
      `${path}.${field}`,
    );
  };

  switch (type) {
    case 'prepayment_months':
    case 'siblings_count': {
      const op = node.op;
      const value = node.value;
      if (typeof op !== 'string' || !KNOWN_COMPARISON_OPS.has(op)) {
        fieldErr('op');
      }
      if (!isFiniteNonNegInt(value)) fieldErr('value');
      return {
        type,
        op: op as ComparisonOp,
        value: value as number,
      } as LeafCondition;
    }
    case 'age_range': {
      const from = node.from_months;
      const to = node.to_months;
      if (!isFiniteNonNegInt(from)) fieldErr('from_months');
      if (!isFiniteNonNegInt(to)) fieldErr('to_months');
      if ((from as number) > (to as number)) fieldErr('from_months');
      return {
        type: 'age_range',
        from_months: from as number,
        to_months: to as number,
      };
    }
    case 'benefit_category': {
      const arr = node.in;
      if (!Array.isArray(arr)) fieldErr('in');
      for (const v of arr as unknown[]) {
        if (typeof v !== 'string' || !KNOWN_BENEFIT_CATEGORIES.has(v)) {
          fieldErr('in');
        }
      }
      return { type: 'benefit_category', in: arr as BenefitCategory[] };
    }
    case 'payment_method': {
      const arr = node.in;
      if (!Array.isArray(arr)) fieldErr('in');
      for (const v of arr as unknown[]) {
        if (typeof v !== 'string' || !KNOWN_PAYMENT_METHODS.has(v)) {
          fieldErr('in');
        }
      }
      return { type: 'payment_method', in: arr as PaymentMethodCode[] };
    }
    case 'early_payment': {
      const days = node.days_before_due;
      if (!isFiniteNonNegInt(days)) fieldErr('days_before_due');
      return { type: 'early_payment', days_before_due: days as number };
    }
    case 'birthday_month': {
      return { type: 'birthday_month' };
    }
    case 'date_range': {
      const from = node.from;
      const to = node.to;
      if (typeof from !== 'string' || !ISO_DATE_RE.test(from)) {
        throw new CustomDiscountConditionsInvalidError(
          'invalid_date_format',
          `${path}.from`,
        );
      }
      if (typeof to !== 'string' || !ISO_DATE_RE.test(to)) {
        throw new CustomDiscountConditionsInvalidError(
          'invalid_date_format',
          `${path}.to`,
        );
      }
      // Reject impossible-month / impossible-day values that pass the regex
      // (e.g. "2026-13-01"). `Date.parse` returns NaN for those.
      if (Number.isNaN(Date.parse(from))) {
        throw new CustomDiscountConditionsInvalidError(
          'invalid_date_format',
          `${path}.from`,
        );
      }
      if (Number.isNaN(Date.parse(to))) {
        throw new CustomDiscountConditionsInvalidError(
          'invalid_date_format',
          `${path}.to`,
        );
      }
      return { type: 'date_range', from, to };
    }
    case 'first_invoice': {
      return { type: 'first_invoice' };
    }
    case 'tariff_types': {
      const arr = node.in;
      if (!Array.isArray(arr)) fieldErr('in');
      for (const v of arr as unknown[]) {
        if (typeof v !== 'string' || !KNOWN_INVOICE_TYPES.has(v)) {
          fieldErr('in');
        }
      }
      return { type: 'tariff_types', in: arr as InvoiceTypeCode[] };
    }
    default:
      // Unreachable — already filtered by KNOWN_LEAF_TYPES above. Belt &
      // braces in case of a future enum addition without a switch update.
      // istanbul ignore next
      throw new CustomDiscountConditionsInvalidError(
        'unknown_condition_type',
        path,
      );
  }
}

// ── Evaluator ─────────────────────────────────────────────────────────────

/**
 * Evaluate a (validated or raw) `conditions` blob against an evaluation
 * context. Empty `{}` always returns `true`. Composites use boolean
 * short-circuit semantics (vacuous truth for empty `all_of`, vacuous
 * falsity for empty `any_of`).
 *
 * The `depth` argument is internal — callers pass the default `0`.
 */
export function evaluateConditions(
  conditions: ConditionsRoot,
  ctx: EvalContext,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) {
    throw new CustomDiscountConditionsInvalidError(
      'conditions_depth_limit_exceeded',
    );
  }
  if (
    typeof conditions !== 'object' ||
    conditions === null ||
    Array.isArray(conditions)
  ) {
    throw new CustomDiscountConditionsInvalidError('invalid_root_shape');
  }

  // Empty object → always matches.
  const keys = Object.keys(conditions);
  if (keys.length === 0) return true;

  if ('all_of' in conditions) {
    const arr = (conditions as { all_of: DiscountCondition[] }).all_of;
    return arr.every((c) =>
      evaluateConditions(c as ConditionsRoot, ctx, depth + 1),
    );
  }
  if ('any_of' in conditions) {
    const arr = (conditions as { any_of: DiscountCondition[] }).any_of;
    return arr.some((c) =>
      evaluateConditions(c as ConditionsRoot, ctx, depth + 1),
    );
  }
  return evaluateLeaf(conditions as LeafCondition, ctx);
}

function compare(op: ComparisonOp, lhs: number, rhs: number): boolean {
  return op === 'gte' ? lhs >= rhs : lhs === rhs;
}

function evaluateLeaf(cond: LeafCondition, ctx: EvalContext): boolean {
  switch (cond.type) {
    case 'prepayment_months': {
      const m = ctx.payment.prepaymentMonths;
      if (m === undefined) return false;
      return compare(cond.op, m, cond.value);
    }
    case 'siblings_count': {
      return compare(cond.op, ctx.family.siblingsInKgCount, cond.value);
    }
    case 'age_range': {
      // Inclusive both ends; from_months <= ageInMonths <= to_months.
      // Validator enforces from_months <= to_months at hydration.
      const a = ctx.child.ageInMonths;
      return a >= cond.from_months && a <= cond.to_months;
    }
    case 'benefit_category': {
      const cat = ctx.child.benefitCategory;
      if (cat === null) return false;
      return cond.in.includes(cat);
    }
    case 'payment_method': {
      const m = ctx.payment.method;
      if (m === undefined) return false;
      return cond.in.includes(m);
    }
    case 'early_payment': {
      const d = ctx.payment.paidEarlyDays;
      if (d === undefined) return false;
      return d >= cond.days_before_due;
    }
    case 'birthday_month': {
      // UTC month comparison: invoice.periodStart and child.birthDate are
      // both stored as timestamptz at midnight Almaty (BP §4 cron uses
      // Asia/Almaty for period boundaries). Their UTC month is therefore
      // the same as the local-Almaty month they were authored against
      // (Almaty is +05:00 with no DST), so a UTC-month comparison here
      // is semantically equivalent to a local-month one.
      return (
        ctx.child.birthDate.getUTCMonth() ===
        ctx.invoice.periodStart.getUTCMonth()
      );
    }
    case 'date_range': {
      // Compare on the calendar date only. `now` is truncated to UTC date
      // boundary; `from` / `to` are "YYYY-MM-DD" parsed as UTC midnight.
      const fromTs = Date.parse(`${cond.from}T00:00:00Z`);
      const toTs = Date.parse(`${cond.to}T23:59:59.999Z`);
      const nowTs = ctx.now.getTime();
      return nowTs >= fromTs && nowTs <= toTs;
    }
    case 'first_invoice': {
      return ctx.family.isFirstInvoiceForChild;
    }
    case 'tariff_types': {
      return cond.in.includes(ctx.invoice.invoiceType);
    }
  }
}
