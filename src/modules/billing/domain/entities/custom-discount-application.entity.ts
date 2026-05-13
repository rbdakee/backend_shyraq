import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { CustomDiscountAmountInvalidError } from '../errors/custom-discount-amount-invalid.error';

export interface CustomDiscountApplicationState {
  id: string;
  kindergartenId: string;
  customDiscountId: string;
  invoiceId: string;
  invoiceLineItemId: string | null;
  childId: string;
  amountApplied: MoneyKzt;
  appliedAt: Date;
}

/**
 * CustomDiscountApplication (B16). Plain POJO with no state machine —
 * applications are immutable ledger entries: created when a discount is
 * applied to an invoice, deleted only by cascade when the parent invoice
 * is deleted.
 *
 * Constructor invariant: `amountApplied > 0` (mirrors DB
 * `chk_custom_discount_applications_amount_positive`).
 *
 * Decision: we reuse `CustomDiscountAmountInvalidError` for both the
 * catalogue `amount` and the applied `amountApplied` invariants — the
 * underlying meaning is identical ("KZT amount must be strictly
 * positive"); the error's `details.amount` carries the offending value.
 */
export class CustomDiscountApplication {
  private constructor(private state: CustomDiscountApplicationState) {
    if (!state.amountApplied.isPositive()) {
      throw new CustomDiscountAmountInvalidError(
        state.amountApplied.toNumber(),
      );
    }
  }

  static fromState(
    s: CustomDiscountApplicationState,
  ): CustomDiscountApplication {
    return new CustomDiscountApplication({ ...s });
  }

  toState(): CustomDiscountApplicationState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }
  get kindergartenId(): string {
    return this.state.kindergartenId;
  }
  get customDiscountId(): string {
    return this.state.customDiscountId;
  }
  get invoiceId(): string {
    return this.state.invoiceId;
  }
  get invoiceLineItemId(): string | null {
    return this.state.invoiceLineItemId;
  }
  get childId(): string {
    return this.state.childId;
  }
  get amountApplied(): MoneyKzt {
    return this.state.amountApplied;
  }
  get appliedAt(): Date {
    return this.state.appliedAt;
  }
}
