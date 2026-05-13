import { MoneyKzt } from './money-kzt';

describe('MoneyKzt — factories', () => {
  it('fromKzt accepts a finite number', () => {
    expect(MoneyKzt.fromKzt(1234.56).toString()).toBe('1234.56');
  });

  it("fromKzt rounds to 2 decimal places using banker's rounding (half-even)", () => {
    // 2.5 → 2 (round to even), 3.5 → 4 (round to even)
    expect(MoneyKzt.fromKzt(2.5).toString()).toBe('2.50');
    expect(MoneyKzt.fromKzt(2.555).toString()).toBe('2.56');
    expect(MoneyKzt.fromKzt(2.545).toString()).toBe('2.54');
    expect(MoneyKzt.fromKzt(2.535).toString()).toBe('2.54');
  });

  it('fromKzt closes the IEEE-754 trap on 0.1 + 0.2', () => {
    // Pre-arithmetic: 0.1 + 0.2 in plain `number` is 0.30000000000000004.
    // The VO converts each operand FIRST, so the addition is in Decimal-land.
    const sum = MoneyKzt.fromKzt(0.1).add(MoneyKzt.fromKzt(0.2));
    expect(sum.equals(MoneyKzt.fromKzt(0.3))).toBe(true);
    expect(sum.toString()).toBe('0.30');
  });

  it('fromKzt accepts a numeric string (DB round-trip path)', () => {
    expect(MoneyKzt.fromKzt('1234.56').toString()).toBe('1234.56');
    expect(MoneyKzt.fromKzt('0.00').toString()).toBe('0.00');
  });

  it('fromKzt throws on null / undefined / NaN / Infinity', () => {
    expect(() => MoneyKzt.fromKzt(null as unknown as number)).toThrow(
      TypeError,
    );
    expect(() => MoneyKzt.fromKzt(undefined as unknown as number)).toThrow(
      TypeError,
    );
    expect(() => MoneyKzt.fromKzt(Number.NaN)).toThrow(TypeError);
    expect(() => MoneyKzt.fromKzt(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => MoneyKzt.fromKzt(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });

  it('fromKzt throws on a non-numeric string', () => {
    expect(() => MoneyKzt.fromKzt('not-a-number')).toThrow(TypeError);
  });

  it('fromString delegates to fromKzt', () => {
    expect(MoneyKzt.fromString('99.99').toString()).toBe('99.99');
  });

  it('zero returns a canonical 0.00 VO', () => {
    expect(MoneyKzt.zero().toString()).toBe('0.00');
    expect(MoneyKzt.zero().isZero()).toBe(true);
  });
});

describe('MoneyKzt — arithmetic', () => {
  it('add returns a new VO and does not mutate the receiver', () => {
    const a = MoneyKzt.fromKzt(100);
    const b = MoneyKzt.fromKzt(50);
    const c = a.add(b);
    expect(c.toString()).toBe('150.00');
    expect(a.toString()).toBe('100.00');
    expect(c).not.toBe(a);
  });

  it('sub may produce a negative MoneyKzt (ledger-balance use case)', () => {
    const balance = MoneyKzt.fromKzt(50).sub(MoneyKzt.fromKzt(80));
    expect(balance.isNegative()).toBe(true);
    expect(balance.toString()).toBe('-30.00');
  });

  it('mul multiplies by a scalar without intermediate float drift', () => {
    // 50000 * 1.1 → 55000 (the historical IEEE bug case stays clean).
    expect(MoneyKzt.fromKzt(50_000).mul(1.1).toString()).toBe('55000.00');
    // 1000 * 15% → 150.00 (no drift)
    expect(MoneyKzt.fromKzt(1000).mul(0.15).toString()).toBe('150.00');
  });

  it("div quantizes to 2dp via banker's rounding at toString()", () => {
    // 100 / 3 → 33.333... → banker rounds to 33.33 at the output boundary.
    expect(MoneyKzt.fromKzt(100).div(3).toString()).toBe('33.33');
    // 50000 / 30 → 1666.666... → 1666.67
    expect(MoneyKzt.fromKzt(50_000).div(30).toString()).toBe('1666.67');
  });

  it('div throws on division by zero', () => {
    expect(() => MoneyKzt.fromKzt(1).div(0)).toThrow(RangeError);
  });

  it('round is a no-op on an already-canonical VO', () => {
    const a = MoneyKzt.fromKzt(123.45);
    expect(a.round().equals(a)).toBe(true);
  });

  it('fluent chains preserve precision until the final round (single-round contract)', () => {
    // Pro-rata refund: amount * remainingDays / totalDays where the
    // intermediate ratio is irrational. Single-step rounding here
    // matches the corrected pro-rata processor formula.
    const amount = MoneyKzt.fromKzt(50_000);
    const refund = amount.mul(7).div(30);
    expect(refund.toString()).toBe('11666.67');
  });

  // ── B22b T15 Codex H1 — single-round contract regressions ───────────────

  it('preserves precision in chained mul/div until explicit round (Codex H1 case)', () => {
    // Repro from B22b T14 Codex review: pre-T15 the .mul() rounded
    // 0.03 * 16.67 = 0.5001 → 0.50 at mul(), then .div(100) rounded
    // 0.005 → 0.00 (banker half-even on the trailing 5). Full-precision
    // propagation yields 0.005001 → round → 0.01.
    const result = MoneyKzt.fromKzt(0.03).mul(16.67).div(100);
    expect(result.round().equals(MoneyKzt.fromKzt(0.01))).toBe(true);
    expect(result.toString()).toBe('0.01');
  });

  it('chains percentage application without precision loss', () => {
    // 100 * 33.33% = 33.33 (exact when boundary-rounded once).
    const amount = MoneyKzt.fromKzt(100).mul(33.33).div(100);
    expect(amount.round().equals(MoneyKzt.fromKzt(33.33))).toBe(true);
    expect(amount.toString()).toBe('33.33');
  });

  it('pro-rata refund single-round contract (5 days of 30, monthly 100000)', () => {
    // 100000 * 5 / 30 = 500000 / 30 = 16666.666... → 16666.67 at boundary.
    const monthly = MoneyKzt.fromKzt(100_000);
    const refund = monthly.mul(5).div(30);
    expect(refund.round().equals(MoneyKzt.fromKzt(16666.67))).toBe(true);
    expect(refund.toString()).toBe('16666.67');
  });

  it('toString quantizes a still-unrounded intermediate (DB boundary)', () => {
    // The DB transformer routes through toString() — confirm the
    // wire-format invariant (2dp) holds even when the receiver carries
    // a higher-precision Decimal internally.
    const intermediate = MoneyKzt.fromKzt(1).div(3); // 0.333...
    expect(intermediate.toString()).toBe('0.33');
    expect(intermediate.toNumber()).toBe(0.33);
  });

  it('mul→div sub-tiyn case does not double-round to zero', () => {
    // Pre-T15: 0.01 * 0.5 = 0.005 → mul() rounded banker-half-even to 0.00,
    // then 0.00 / 1 = 0.00. Now: 0.005 preserved → div(1) = 0.005 →
    // round() at boundary → 0.00 (banker on 5 followed by zero rounds
    // to even-zero — that part of the contract holds).
    const r = MoneyKzt.fromKzt(0.01).mul(0.5);
    // The unrounded carrier still serialises to 2dp:
    expect(r.toString()).toBe('0.00');
    // …but compounding with another step preserves the underlying 0.005
    // until we round once at the end.
    const r2 = MoneyKzt.fromKzt(0.01).mul(0.5).mul(2);
    expect(r2.toString()).toBe('0.01');
  });
});

describe('MoneyKzt — comparison', () => {
  it('equals compares by canonical value', () => {
    expect(MoneyKzt.fromKzt(1.5).equals(MoneyKzt.fromKzt(1.5))).toBe(true);
    expect(MoneyKzt.fromKzt(1.5).equals(MoneyKzt.fromKzt(1.51))).toBe(false);
    // Different ctor inputs, identical canonical value.
    expect(MoneyKzt.fromKzt('1.50').equals(MoneyKzt.fromKzt(1.5))).toBe(true);
  });

  it('gt / gte / lt / lte cover the four strict/lenient orderings', () => {
    const a = MoneyKzt.fromKzt(10);
    const b = MoneyKzt.fromKzt(20);
    const eq = MoneyKzt.fromKzt(10);
    expect(b.gt(a)).toBe(true);
    expect(a.gt(b)).toBe(false);
    expect(a.gte(eq)).toBe(true);
    expect(a.lt(b)).toBe(true);
    expect(a.lte(eq)).toBe(true);
  });

  it('isZero / isPositive / isNegative are mutually exclusive', () => {
    const zero = MoneyKzt.zero();
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);

    const pos = MoneyKzt.fromKzt(1);
    expect(pos.isPositive()).toBe(true);
    expect(pos.isZero()).toBe(false);
    expect(pos.isNegative()).toBe(false);

    const neg = MoneyKzt.fromKzt(-1);
    expect(neg.isNegative()).toBe(true);
    expect(neg.isPositive()).toBe(false);
    expect(neg.isZero()).toBe(false);
  });
});

describe('MoneyKzt — serialisation', () => {
  it('toString emits a fixed-point 2dp string', () => {
    expect(MoneyKzt.fromKzt(1234).toString()).toBe('1234.00');
    expect(MoneyKzt.fromKzt(0).toString()).toBe('0.00');
    expect(MoneyKzt.fromKzt(-7.5).toString()).toBe('-7.50');
  });

  it('toNumber emits a plain JS number', () => {
    expect(MoneyKzt.fromKzt(1234.56).toNumber()).toBe(1234.56);
    expect(MoneyKzt.fromKzt('0.00').toNumber()).toBe(0);
  });

  it('toJSON returns a number so JSON.stringify emits a plain number', () => {
    const m = MoneyKzt.fromKzt(99.99);
    expect(m.toJSON()).toBe(99.99);
    expect(JSON.stringify(m)).toBe('99.99');
    expect(JSON.stringify({ amount: m })).toBe('{"amount":99.99}');
  });

  it('toString round-trips via fromString', () => {
    const orig = MoneyKzt.fromKzt(8675.3);
    const round = MoneyKzt.fromString(orig.toString());
    expect(round.equals(orig)).toBe(true);
  });
});

describe('MoneyKzt — immutability', () => {
  it('instances are frozen (cannot reassign internal state)', () => {
    const m = MoneyKzt.fromKzt(100);
    expect(Object.isFrozen(m)).toBe(true);
    // TS would block this at compile time; the runtime freeze closes the
    // any-cast bypass route too.
    expect(() => {
      (m as unknown as { value: unknown }).value = 'tampered';
    }).toThrow();
  });
});
