import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';

export interface InvoiceLineItemState {
  id: string;
  invoiceId: string;
  kindergartenId: string;
  description: string;
  tariffPlanId: string | null;
  quantity: number;
  unitPrice: MoneyKzt;
  lineTotal: MoneyKzt;
  createdAt: Date;
}

/**
 * Invoice line item — append-only, one per row. Constructor enforces
 * arithmetic consistency (`lineTotal ≈ quantity * unitPrice`) to two
 * decimal places. Use `compute(quantity, unitPrice)` to derive the
 * canonical `lineTotal` before construction.
 */
export class InvoiceLineItem {
  private constructor(private readonly state: InvoiceLineItemState) {
    if (!(state.quantity > 0)) {
      throw new Error('InvoiceLineItem: quantity must be > 0');
    }
    if (state.unitPrice.isNegative()) {
      throw new Error('InvoiceLineItem: unitPrice must be >= 0');
    }
    if (state.lineTotal.isNegative()) {
      throw new Error('InvoiceLineItem: lineTotal must be >= 0');
    }
    const expected = state.unitPrice.mul(state.quantity);
    // numeric(12,2) round-trip noise — tolerate sub-cent drift
    const drift = state.lineTotal.sub(expected);
    const driftAbs = drift.isNegative() ? MoneyKzt.zero().sub(drift) : drift;
    if (driftAbs.gt(MoneyKzt.fromKzt(0.01))) {
      throw new Error(
        `InvoiceLineItem: lineTotal (${state.lineTotal.toString()}) does not match quantity*unitPrice (${expected.toString()})`,
      );
    }
  }

  static fromState(s: InvoiceLineItemState): InvoiceLineItem {
    return new InvoiceLineItem({ ...s });
  }

  toState(): InvoiceLineItemState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get invoiceId(): string {
    return this.state.invoiceId;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get description(): string {
    return this.state.description;
  }

  get tariffPlanId(): string | null {
    return this.state.tariffPlanId;
  }

  get quantity(): number {
    return this.state.quantity;
  }

  get unitPrice(): MoneyKzt {
    return this.state.unitPrice;
  }

  get lineTotal(): MoneyKzt {
    return this.state.lineTotal;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  // ── pure helper ────────────────────────────────────────────────────────

  static compute(quantity: number, unitPrice: MoneyKzt): MoneyKzt {
    return unitPrice.mul(quantity);
  }
}
