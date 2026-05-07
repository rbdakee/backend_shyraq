import {
  DiscountRules,
  TariffPlan,
} from '../../domain/entities/tariff-plan.entity';
import { Invoice, InvoiceType } from '../../domain/entities/invoice.entity';
import { PaymentProvider } from '../../domain/entities/payment.entity';

/**
 * DiscountEnginePort — pluggable discount evaluator. The default Mock impl
 * (B13) handles sibling + prepay rules from `tariff_plans.discount_rules`.
 * B16 will add the custom-discount rule engine behind the same port.
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
    amountDue: number;
    periodStart: Date;
    periodEnd: Date;
  };
  tariffPlan: {
    id: string;
    discountRules: DiscountRules;
  };
  context: {
    siblingsCount?: number;
    isFirstPayment?: boolean;
    paymentMethod?: PaymentProvider;
    prepaymentMonths?: number;
  };
}

export interface DiscountEvaluationResult {
  /** 0–100 inclusive when applicable; null when no rules matched. */
  discountPct: number | null;
  /** Human-readable, comma-joined when stacked. e.g. `'sibling_discount,prepay_12m'`. */
  discountReason: string | null;
  /** Rule IDs that contributed (audit trail). */
  appliedRules: string[];
}

export abstract class DiscountEnginePort {
  abstract evaluate(
    input: DiscountEvaluationInput,
  ): Promise<DiscountEvaluationResult>;
}

// Re-export domain types used in the input shape so consumers don't have to
// reach into `domain/entities/*` for types tied to the evaluation contract.
export type { Invoice, TariffPlan };
