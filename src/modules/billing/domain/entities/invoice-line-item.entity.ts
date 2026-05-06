export interface InvoiceLineItemState {
  id: string;
  invoiceId: string;
  kindergartenId: string;
  description: string;
  tariffPlanId: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
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
    if (state.unitPrice < 0) {
      throw new Error('InvoiceLineItem: unitPrice must be >= 0');
    }
    if (state.lineTotal < 0) {
      throw new Error('InvoiceLineItem: lineTotal must be >= 0');
    }
    const expected = state.quantity * state.unitPrice;
    // numeric(12,2) round-trip noise — tolerate sub-cent drift
    if (Math.abs(state.lineTotal - expected) > 0.01) {
      throw new Error(
        `InvoiceLineItem: lineTotal (${state.lineTotal}) does not match quantity*unitPrice (${expected})`,
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

  get unitPrice(): number {
    return this.state.unitPrice;
  }

  get lineTotal(): number {
    return this.state.lineTotal;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  // ── pure helper ────────────────────────────────────────────────────────

  static compute(quantity: number, unitPrice: number): number {
    return Math.round(quantity * unitPrice * 100) / 100;
  }
}
