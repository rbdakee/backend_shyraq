import { InvariantViolationError } from '../errors/invariant-violation.error';

const CURRENCY_RE = /^[A-Z]{3}$/;

export class MonetaryAmount {
  private constructor(
    private readonly minorUnits: number,
    private readonly currency: string,
  ) {}

  static of(minorUnits: number, currency: string): MonetaryAmount {
    if (!Number.isInteger(minorUnits) || minorUnits < 0) {
      throw new InvariantViolationError(
        'minorUnits must be a non-negative integer',
      );
    }
    if (!CURRENCY_RE.test(currency)) {
      throw new InvariantViolationError(
        'currency must be ISO 4217 three-letter uppercase code',
      );
    }
    return new MonetaryAmount(minorUnits, currency);
  }

  toMinorUnits(): number {
    return this.minorUnits;
  }

  toCurrency(): string {
    return this.currency;
  }

  equals(other: MonetaryAmount): boolean {
    return (
      this.minorUnits === other.minorUnits && this.currency === other.currency
    );
  }
}
