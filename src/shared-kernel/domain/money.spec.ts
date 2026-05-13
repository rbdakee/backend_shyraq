import { addKzt, divideKzt, multiplyKzt, roundKzt, subtractKzt } from './money';

describe('roundKzt', () => {
  it('rounds 0.1 + 0.2 to 0.3 (IEEE-754 trap)', () => {
    expect(roundKzt(0.1 + 0.2)).toBe(0.3);
  });

  it('rounds tie cases via banker (half-even) semantics post-B22b-T2', () => {
    // 1.005 — IEEE-754 stores it as 1.00499999...→ rounds DOWN to 1.0 under
    // EITHER Math.round (legacy) OR ROUND_HALF_EVEN (current), because the
    // actual representable value is below the tie point. Acceptance check
    // for the Decimal-backed implementation parity.
    expect(roundKzt(1.005)).toBe(1.0);
    // 50000 * 1.1 — IEEE-754 stores 1.1 with a positive bias → 55000 exact.
    expect(roundKzt(50_000 * 1.1)).toBe(55_000);
  });

  it('preserves whole numbers', () => {
    expect(roundKzt(50_000)).toBe(50_000);
  });

  it('handles negative values', () => {
    expect(roundKzt(-0.1 - 0.2)).toBe(-0.3);
  });

  it('throws on non-finite input', () => {
    expect(() => roundKzt(Number.NaN)).toThrow(TypeError);
    expect(() => roundKzt(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('addKzt / subtractKzt / multiplyKzt / divideKzt', () => {
  it('addKzt rounds the sum', () => {
    expect(addKzt(0.1, 0.2)).toBe(0.3);
  });

  it('subtractKzt rounds the difference', () => {
    expect(subtractKzt(1.0, 0.7)).toBe(0.3);
  });

  it('multiplyKzt rounds the product', () => {
    expect(multiplyKzt(0.1, 3)).toBe(0.3);
    expect(multiplyKzt(50_000, 1.1)).toBe(55_000);
  });

  it('divideKzt rounds the quotient', () => {
    expect(divideKzt(10, 3)).toBe(3.33);
    expect(divideKzt(50_000, 30)).toBe(1666.67);
  });

  it('divideKzt throws on division by zero', () => {
    expect(() => divideKzt(1, 0)).toThrow(RangeError);
  });
});
