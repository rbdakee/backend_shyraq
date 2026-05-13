/**
 * Money helpers — KZT, two-decimal places.
 *
 * B22b T2 (closes B13 T11 H7): arithmetic is now Decimal-backed, routed
 * through `MoneyKzt` from `./money-kzt`. The function signatures stay
 * `(number) => number` for callsite-compat — every callsite gets the
 * IEEE-754 precision fix without code changes. `roundKzt(0.1 + 0.2)` is
 * still `0.3` here, but the addition + rounding inside the VO are
 * banker-rounded Decimal ops, not lossy IEEE-754 + Math.round.
 *
 * Migration roadmap (carry-forward from B22b T2):
 *   - All NEW callsites SHOULD prefer `MoneyKzt` directly — `import {
 *     MoneyKzt } from '@/shared-kernel/domain/money-kzt'` — to get the
 *     immutable VO surface (add/sub/mul/div, isZero/isPositive, etc.).
 *   - Existing callsites in `src/modules/billing/` continue to use these
 *     helpers as a transitional compatibility layer. Migrating their
 *     domain-entity state shapes from `number` → `MoneyKzt` lands in a
 *     follow-up task (state-shape change ripples through 8 entities, 9
 *     TypeORM mappings, 4 services, presenters, DTOs, and the entire
 *     billing spec suite — too disruptive for one PR).
 *
 * Public surface:
 *   - All helpers round to 2dp via banker's (ROUND_HALF_EVEN) rounding,
 *     the financial-industry default.
 *   - `null`/`undefined` inputs propagate via the typed signature — they
 *     are NOT silently coerced. Callers handle `null` explicitly.
 *   - `divideKzt` throws on division by zero (no silent `Infinity`).
 *   - Functions are pure; no side effects, no I/O.
 *
 * `@deprecated` is documented but not annotated programmatically because
 * every domain entity and service still consumes these helpers — flipping
 * the JSDoc tag would flood the build with warnings. Tag removal is part
 * of the follow-up migration.
 */
import { MoneyKzt } from './money-kzt';

/**
 * Round to 2 decimal places via banker's rounding.
 *
 * `roundKzt(0.1 + 0.2)` returns `0.3` — the IEEE-754 trap is closed by
 * routing the round through `MoneyKzt.fromKzt` (Decimal-backed). Note
 * that the JS `+` happens BEFORE the call, so the operand is already
 * `0.30000000000000004`; the rounding step pulls it back to `0.3`.
 * Prefer `MoneyKzt.fromKzt(a).add(MoneyKzt.fromKzt(b))` when the
 * intermediate precision matters (e.g. chained arithmetic).
 */
export function roundKzt(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `roundKzt: expected finite number, got ${String(value)}`,
    );
  }
  return MoneyKzt.fromKzt(value).toNumber();
}

/** `MoneyKzt.fromKzt(a).add(MoneyKzt.fromKzt(b))` → number. */
export function addKzt(a: number, b: number): number {
  return MoneyKzt.fromKzt(a).add(MoneyKzt.fromKzt(b)).toNumber();
}

/** `MoneyKzt.fromKzt(a).sub(MoneyKzt.fromKzt(b))` → number. */
export function subtractKzt(a: number, b: number): number {
  return MoneyKzt.fromKzt(a).sub(MoneyKzt.fromKzt(b)).toNumber();
}

/** `MoneyKzt.fromKzt(a).mul(b)` → number. */
export function multiplyKzt(a: number, b: number): number {
  if (!Number.isFinite(b)) {
    throw new TypeError(
      `multiplyKzt: expected finite number, got ${String(b)}`,
    );
  }
  return MoneyKzt.fromKzt(a).mul(b).toNumber();
}

/**
 * `MoneyKzt.fromKzt(a).div(b)` → number. Throws `RangeError` on
 * division by zero rather than returning `Infinity` / `NaN` which would
 * be silently coerced to `0` later in the pipeline. Callers that need a
 * fallback must guard `b !== 0` before calling.
 */
export function divideKzt(a: number, b: number): number {
  if (!Number.isFinite(b)) {
    throw new TypeError(`divideKzt: expected finite number, got ${String(b)}`);
  }
  if (b === 0) {
    throw new RangeError('divideKzt: divisor is zero');
  }
  return MoneyKzt.fromKzt(a).div(b).toNumber();
}
