/**
 * Money helpers — KZT, two-decimal places.
 *
 * Today billing math is held as a plain `number` (IEEE-754 double) which is
 * lossy when intermediate values drift below the cent boundary. The minimum
 * fix (T11 H7) is to centralise rounding so every arithmetic call ends in a
 * canonical 2dp form. A future migration to `decimal.js` or BigInt-backed
 * tiyn (1 KZT = 100 tiyn) is tracked under `// TODO(B22): migrate to
 * Decimal-backed money type`.
 *
 * Convention:
 *   - All public helpers return values rounded to 2dp.
 *   - `null`/`undefined` inputs propagate via the typed signature; they are
 *     not silently coerced. Callers handle `null` explicitly.
 *   - Functions are pure; no side effects, no I/O.
 */

const SCALE = 100;

/**
 * Round to 2 decimal places via the canonical "scale, round, descale"
 * pattern. Centralised to keep behaviour consistent across the codebase
 * (cron, hook, parent-pay, refund, payment_account ledger).
 *
 * `roundKzt(0.1 + 0.2)` returns `0.3` — the IEEE-754 trap is closed.
 */
export function roundKzt(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `roundKzt: expected finite number, got ${String(value)}`,
    );
  }
  return Math.round(value * SCALE) / SCALE;
}

/** `roundKzt(a + b)` */
export function addKzt(a: number, b: number): number {
  return roundKzt(a + b);
}

/** `roundKzt(a - b)` */
export function subtractKzt(a: number, b: number): number {
  return roundKzt(a - b);
}

/** `roundKzt(a * b)` */
export function multiplyKzt(a: number, b: number): number {
  return roundKzt(a * b);
}

/**
 * `roundKzt(a / b)` — throws on division by zero rather than returning
 * `Infinity` / `NaN` which would be silently rounded to `0` later in the
 * pipeline. Callers that need a fallback must guard `b !== 0` before
 * calling.
 */
export function divideKzt(a: number, b: number): number {
  if (b === 0) {
    throw new RangeError('divideKzt: divisor is zero');
  }
  return roundKzt(a / b);
}
