/**
 * MoneyKzt — value object for KZT amounts at two-decimal-place precision.
 *
 * B22b T2 / closes B13 T11 H7 — eliminates the IEEE-754 trap that lossy
 * `number`-backed arithmetic introduced. All math here goes through
 * `decimal.js`. Quantization to `numeric(12,2)` semantics (banker's
 * rounding, `ROUND_HALF_EVEN`) happens ONLY at boundaries:
 *
 *   - `fromKzt(n)` / `fromString(s)` — input boundary (wire format is ≤2dp).
 *   - `round()` — caller-requested explicit re-round.
 *   - `toString()` — DB-canonical fixed-point string (also forces 2dp).
 *   - `toNumber()` / `toJSON()` — JS-number output boundary.
 *   - `moneyKztTransformer.to()` — DB serialization boundary.
 *
 * Internally, `mul()` / `div()` / `add()` / `sub()` PROPAGATE FULL
 * `Decimal` precision (banker's rounding still applied process-wide on
 * any explicit `.toDecimalPlaces`). This matters for chained percentage /
 * pro-rata calculations like `amount.mul(pct).div(100)` or
 * `monthly.mul(remainingDays).div(totalDays)` — rounding ONLY at the
 * outer boundary matches the BP contract that financial values are
 * "single-rounded" per expression.
 *
 * B22b T15 — closes Codex H1: previously `.mul()` / `.div()` rounded to
 * 2dp inside each call, so a chain like
 * `MoneyKzt.fromKzt(0.03).mul(16.67).div(100)` first rounded
 * `0.5001 → 0.50`, then `0.005 → 0.00` (banker, half-even on the 5).
 * Full-precision propagation yields `0.005001 → round → 0.01`. The fix
 * preserves the original at-rest invariant (every persisted/serialised
 * MoneyKzt is 2dp) by quantizing at the output boundaries.
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
 * Value object for KZT amounts. Carries a full-precision `Decimal`
 * internally so chained arithmetic (`mul`/`div`/`add`/`sub`) does not
 * lose information mid-expression. Quantization to the canonical 2dp
 * representation occurs only at boundaries (`fromKzt`, explicit
 * `round()`, `toString`, `toNumber`/`toJSON`, DB transformer). The
 * combination preserves the at-rest invariant — every value that
 * crosses an output boundary is exactly 2dp — without forcing
 * intermediate rounds that would corrupt single-round chains.
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
   * Rounds to 2dp using banker's rounding (input boundary — wire format
   * is `numeric(12,2)`-compatible). Throws `TypeError` on
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
    return new MoneyKzt(new Decimal(0));
  }

  // ── arithmetic ────────────────────────────────────────────────────────
  //
  // Arithmetic methods PROPAGATE FULL precision — they do NOT quantize
  // to 2dp. Quantization happens only at the boundaries listed in the
  // class JSDoc. This makes `a.mul(p).div(100)` single-rounded at the
  // sink (e.g. `.toString()` for the DB write, or explicit `.round()`).

  add(other: MoneyKzt): MoneyKzt {
    return new MoneyKzt(this.value.plus(other.value));
  }

  sub(other: MoneyKzt): MoneyKzt {
    return new MoneyKzt(this.value.minus(other.value));
  }

  /**
   * Multiply by a unitless scalar (e.g. discount factor, day count). The
   * scalar may be a JS `number` or a `Decimal`. Full intermediate
   * precision is preserved; quantize at the outer boundary
   * (`.round()` / `.toString()` / DB transformer).
   */
  mul(factor: number | Decimal): MoneyKzt {
    return new MoneyKzt(this.value.mul(factor));
  }

  /**
   * Divide by a unitless scalar. Throws `RangeError` on zero (matches
   * the legacy `divideKzt` behaviour — never silently emits Infinity).
   * Full intermediate precision is preserved; quantize at the outer
   * boundary (`.round()` / `.toString()` / DB transformer).
   */
  div(divisor: number | Decimal): MoneyKzt {
    const d = new Decimal(divisor);
    if (d.isZero()) {
      throw new RangeError('MoneyKzt.div: divisor is zero');
    }
    return new MoneyKzt(this.value.div(d));
  }

  /**
   * Re-quantize to 2dp via banker's rounding. Use this when an explicit
   * "snap to wire-format" is required mid-chain (e.g. inserting a
   * pro-rata refund whose downstream comparison expects the same 2dp
   * value the DB will hold).
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
   * numeric(12,2) ceiling). Used at the DTO/HTTP boundary. Quantizes to
   * 2dp via banker's rounding so the wire-format invariant
   * (`numeric(12,2)`) holds even when called on an unrounded
   * intermediate (e.g. straight after `.mul().div()`).
   */
  toNumber(): number {
    return this.value.toDecimalPlaces(SCALE).toNumber();
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
