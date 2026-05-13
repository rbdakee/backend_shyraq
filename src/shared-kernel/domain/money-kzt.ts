/**
 * MoneyKzt — value object for KZT amounts at two-decimal-place precision.
 *
 * B22b T2 / closes B13 T11 H7 — eliminates the IEEE-754 trap that lossy
 * `number`-backed arithmetic introduced. All math here goes through
 * `decimal.js` and rounds to 2dp at every public boundary using
 * banker's rounding (`ROUND_HALF_EVEN`), the financial-industry default.
 *
 * Storage decision (intentional deviation from §5 Part B T2 of the plan):
 * the DB schema stays at `numeric(12,2)` — Postgres `numeric` is already
 * arbitrary-precision, the real problem was only the in-memory
 * `number` lossiness. The TypeORM `ValueTransformer` in
 * `infrastructure/typeorm/money-kzt.transformer.ts` maps
 * `string ↔ MoneyKzt` so domain code never touches `number` for money
 * once it enters the runtime.
 *
 * Wire-format decision: DTOs stay `number` (JSON-friendly). The
 * service layer translates at the boundary — input
 * `MoneyKzt.fromKzt(dto.amount)`, output `entity.amount.toNumber()`.
 * `toJSON()` is provided so `JSON.stringify(entity.amount)` emits a
 * plain number too (defensive — the presenter is the canonical
 * boundary).
 *
 * Negatives ARE allowed — `subtractKzt` did not reject them and several
 * ledger flows (`payment_account.balance`) rely on the signed semantics.
 * `isNegative()` / `isPositive()` are accessors, NOT invariants.
 *
 * Immutability: instances are frozen at construction. Every arithmetic
 * method returns a NEW `MoneyKzt` — the receiver never mutates.
 */
import { Decimal } from 'decimal.js';

// Banker's rounding (ROUND_HALF_EVEN) is the IEEE 754 financial default —
// `MoneyKzt.fromKzt(2.5).round()` → 2 (not 3); `3.5` → 4. This is set
// process-wide on the `Decimal` constructor; every `MoneyKzt` operation
// inherits it. `precision: 30` is generous (the natural ceiling for
// numeric(12,2) products is ~24 significant digits).
Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN, precision: 30 });

const SCALE = 2;

/**
 * Value object for KZT amounts. Always carries a 2dp-rounded `Decimal`
 * internally; arithmetic methods round once at the boundary so
 * intermediate precision is preserved within an expression chain.
 */
export class MoneyKzt {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
    Object.freeze(this);
  }

  // ── factories ─────────────────────────────────────────────────────────

  /**
   * Build a `MoneyKzt` from a JS `number` or numeric string.
   *
   * Rounds to 2dp using banker's rounding. Throws `TypeError` on
   * `null`/`undefined`/`NaN`/`±Infinity` — matches the legacy
   * `roundKzt(NaN)` behaviour so callers don't silently coerce
   * malformed input.
   */
  static fromKzt(n: number | string): MoneyKzt {
    if (n === null || n === undefined) {
      throw new TypeError(
        `MoneyKzt.fromKzt: expected number or string, got ${String(n)}`,
      );
    }
    if (typeof n === 'number' && !Number.isFinite(n)) {
      throw new TypeError(
        `MoneyKzt.fromKzt: expected finite number, got ${String(n)}`,
      );
    }
    let d: Decimal;
    try {
      d = new Decimal(n);
    } catch {
      throw new TypeError(
        `MoneyKzt.fromKzt: cannot parse ${String(n)} as decimal`,
      );
    }
    if (d.isNaN() || !d.isFinite()) {
      throw new TypeError(
        `MoneyKzt.fromKzt: expected finite number, got ${String(n)}`,
      );
    }
    return new MoneyKzt(d.toDecimalPlaces(SCALE));
  }

  /**
   * Parse a `numeric(N,2)` string from the DB driver. Identical to
   * `fromKzt(s)` but kept as a separate factory so the TypeORM
   * transformer call-site is self-documenting.
   */
  static fromString(s: string): MoneyKzt {
    return MoneyKzt.fromKzt(s);
  }

  /** Zero. The neutral element for `add`/`sub`. */
  static zero(): MoneyKzt {
    return new MoneyKzt(new Decimal(0).toDecimalPlaces(SCALE));
  }

  // ── arithmetic ────────────────────────────────────────────────────────

  add(other: MoneyKzt): MoneyKzt {
    return new MoneyKzt(this.value.plus(other.value).toDecimalPlaces(SCALE));
  }

  sub(other: MoneyKzt): MoneyKzt {
    return new MoneyKzt(this.value.minus(other.value).toDecimalPlaces(SCALE));
  }

  /**
   * Multiply by a unitless scalar (e.g. discount factor, day count). The
   * scalar may be a JS `number` or a `Decimal`; intermediate precision is
   * preserved before the final 2dp rounding.
   */
  mul(factor: number | Decimal): MoneyKzt {
    return new MoneyKzt(this.value.mul(factor).toDecimalPlaces(SCALE));
  }

  /**
   * Divide by a unitless scalar. Throws `RangeError` on zero (matches
   * the legacy `divideKzt` behaviour — never silently emits Infinity).
   */
  div(divisor: number | Decimal): MoneyKzt {
    const d = new Decimal(divisor);
    if (d.isZero()) {
      throw new RangeError('MoneyKzt.div: divisor is zero');
    }
    return new MoneyKzt(this.value.div(d).toDecimalPlaces(SCALE));
  }

  /**
   * Re-round to 2dp via banker's rounding. No-op when the value is
   * already canonical (every method returns a 2dp value), exposed for
   * code-clarity in fluent chains that explicitly want a rounding marker.
   */
  round(): MoneyKzt {
    return new MoneyKzt(this.value.toDecimalPlaces(SCALE));
  }

  // ── comparison ────────────────────────────────────────────────────────

  equals(other: MoneyKzt): boolean {
    return this.value.equals(other.value);
  }

  gt(other: MoneyKzt): boolean {
    return this.value.greaterThan(other.value);
  }

  gte(other: MoneyKzt): boolean {
    return this.value.greaterThanOrEqualTo(other.value);
  }

  lt(other: MoneyKzt): boolean {
    return this.value.lessThan(other.value);
  }

  lte(other: MoneyKzt): boolean {
    return this.value.lessThanOrEqualTo(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  // ── serialisation ─────────────────────────────────────────────────────

  /**
   * Canonical DB string — fixed-point, no exponent, exactly 2dp.
   *
   * `MoneyKzt.zero().toString()` → `"0.00"`. Used by the TypeORM
   * transformer to hand a stable `numeric` literal to node-postgres.
   */
  toString(): string {
    return this.value.toFixed(SCALE);
  }

  /**
   * Plain `number` (lossy for sufficiently-large values — fine for the
   * numeric(12,2) ceiling). Used at the DTO/HTTP boundary.
   */
  toNumber(): number {
    return this.value.toNumber();
  }

  /**
   * JSON encoding hook — emits a plain number so accidental
   * `JSON.stringify(entityState)` does not leak the internal `Decimal`
   * representation. The canonical boundary remains the presenter; this
   * is defence-in-depth.
   */
  toJSON(): number {
    return this.toNumber();
  }
}
