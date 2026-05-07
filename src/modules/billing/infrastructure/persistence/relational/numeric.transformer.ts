import { ValueTransformer } from 'typeorm';

/**
 * TypeORM column transformer for `numeric(N,2)` money columns.
 *
 * Postgres returns NUMERIC values to node-postgres as strings to avoid
 * precision loss when the column outgrows JS `number`. For the KZT amounts
 * used here (capped at numeric(12,2)) the loss is irrelevant — converting to
 * `number` keeps domain code from littering parseFloat() calls everywhere.
 *
 * `null` round-trips unchanged; non-null `from` values pass through
 * `parseFloat`. `to` returns numbers as-is — node-postgres serialises them
 * for the wire.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null | undefined): number | null | undefined => {
    if (value === null || value === undefined) return value as null | undefined;
    if (typeof value === 'number') return value;
    return parseFloat(value);
  },
};
