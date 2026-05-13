import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { TariffPlan } from './tariff-plan.entity';

export interface TariffAssignmentState {
  id: string;
  kindergartenId: string;
  childId: string;
  tariffPlanId: string;
  customAmount: MoneyKzt | null;
  customReason: string | null;
  validFrom: Date;
  validUntil: Date | null;
  assignedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * TariffAssignment — links a child to a tariff plan with optional
 * `customAmount` override. Light invariants on construction:
 *
 *   customAmount set       → customAmount >= 0
 *   validUntil set         → validUntil >= validFrom
 *
 * `close(now)` sets `validUntil = today` and is idempotent. `effectiveAmount`
 * resolves the actual KZT amount the child is billed against the plan.
 */
export class TariffAssignment {
  private constructor(private state: TariffAssignmentState) {
    if (state.customAmount !== null && state.customAmount.isNegative()) {
      throw new Error('TariffAssignment: customAmount must be >= 0');
    }
    if (
      state.validUntil !== null &&
      state.validUntil.getTime() < state.validFrom.getTime()
    ) {
      throw new Error('TariffAssignment: validUntil must be >= validFrom');
    }
  }

  static fromState(s: TariffAssignmentState): TariffAssignment {
    return new TariffAssignment({ ...s });
  }

  toState(): TariffAssignmentState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get childId(): string {
    return this.state.childId;
  }

  get tariffPlanId(): string {
    return this.state.tariffPlanId;
  }

  get customAmount(): MoneyKzt | null {
    return this.state.customAmount;
  }

  get customReason(): string | null {
    return this.state.customReason;
  }

  get validFrom(): Date {
    return this.state.validFrom;
  }

  get validUntil(): Date | null {
    return this.state.validUntil;
  }

  get assignedBy(): string {
    return this.state.assignedBy;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── methods ─────────────────────────────────────────────────────────────

  /**
   * Close the assignment as of `now`. Idempotent — calling on an
   * already-closed assignment leaves `validUntil` unchanged but still
   * touches `updatedAt`.
   */
  close(now: Date): void {
    if (this.state.validUntil === null) {
      this.state.validUntil = toDateOnlyUtc(now);
    }
    this.state.updatedAt = now;
  }

  /**
   * Resolves the billable amount: `customAmount` takes precedence,
   * otherwise the linked plan's `amount`. Caller must pass the matching
   * `TariffPlan` (id alignment is the caller's responsibility).
   */
  effectiveAmount(tariffPlan: TariffPlan): MoneyKzt {
    return this.state.customAmount ?? tariffPlan.amount;
  }
}

function toDateOnlyUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
