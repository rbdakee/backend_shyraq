import { MonetaryAmount } from './monetary-amount.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('MonetaryAmount', () => {
  it('creates a valid monetary amount', () => {
    const amount = MonetaryAmount.of(1000, 'KZT');
    expect(amount.toMinorUnits()).toBe(1000);
    expect(amount.toCurrency()).toBe('KZT');
  });

  it('accepts zero minor units', () => {
    const amount = MonetaryAmount.of(0, 'KZT');
    expect(amount.toMinorUnits()).toBe(0);
  });

  it('throws InvariantViolationError for negative minor units', () => {
    expect(() => MonetaryAmount.of(-1, 'KZT')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for non-integer minor units', () => {
    expect(() => MonetaryAmount.of(1.5, 'KZT')).toThrow(
      InvariantViolationError,
    );
  });

  it('throws InvariantViolationError for lowercase currency', () => {
    expect(() => MonetaryAmount.of(1000, 'kzt')).toThrow(
      InvariantViolationError,
    );
  });

  it('throws InvariantViolationError for 2-letter currency', () => {
    expect(() => MonetaryAmount.of(1000, 'KZ')).toThrow(
      InvariantViolationError,
    );
  });

  it('throws InvariantViolationError for 4-letter currency', () => {
    expect(() => MonetaryAmount.of(1000, 'KZTT')).toThrow(
      InvariantViolationError,
    );
  });

  it('throws InvariantViolationError for empty currency', () => {
    expect(() => MonetaryAmount.of(1000, '')).toThrow(InvariantViolationError);
  });

  it('equals returns true for same values', () => {
    const a = MonetaryAmount.of(1000, 'KZT');
    const b = MonetaryAmount.of(1000, 'KZT');
    expect(a.equals(b)).toBe(true);
  });

  it('equals returns false for different minorUnits', () => {
    const a = MonetaryAmount.of(1000, 'KZT');
    const b = MonetaryAmount.of(2000, 'KZT');
    expect(a.equals(b)).toBe(false);
  });

  it('equals returns false for different currency', () => {
    const a = MonetaryAmount.of(1000, 'KZT');
    const b = MonetaryAmount.of(1000, 'USD');
    expect(a.equals(b)).toBe(false);
  });
});
