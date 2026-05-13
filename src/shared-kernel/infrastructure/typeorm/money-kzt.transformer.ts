import { ValueTransformer } from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';

/**
 * TypeORM column transformer for `numeric(N,2)` money columns.
 *
 * B22b T2 — supersedes `numeric.transformer.ts` (which mapped
 * `numeric ↔ number` and re-introduced the IEEE-754 trap the moment
 * domain code touched the value). This transformer round-trips
 * `string ↔ MoneyKzt` so the domain layer never sees a raw `number`.
 *
 * Direction-by-direction:
 *   - `from(raw: string | null)`: node-postgres returns NUMERIC columns
 *     as strings to preserve precision. We hand them straight to
 *     `MoneyKzt.fromString` — `null` round-trips unchanged.
 *   - `to(value: MoneyKzt | null)`: `MoneyKzt.toString()` emits a fixed-
 *     point 2dp literal that PG ingests verbatim.
 *
 * The transformer is a singleton — there's no per-call state, so the
 * value is exported as a constant rather than a factory.
 */
export const moneyKztTransformer: ValueTransformer = {
  to: (value: MoneyKzt | null | undefined): string | null | undefined => {
    if (value === null || value === undefined) return value as null | undefined;
    return value.toString();
  },
  from: (value: string | null | undefined): MoneyKzt | null | undefined => {
    if (value === null || value === undefined) return value as null | undefined;
    // Defence-in-depth: an older driver / a hand-rolled raw query could
    // surface a JS `number` despite TypeORM's `numeric ↔ string` default.
    // `MoneyKzt.fromKzt` handles both shapes.
    if (typeof value === 'number') return MoneyKzt.fromKzt(value);
    return MoneyKzt.fromString(value);
  },
};
