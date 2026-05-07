/**
 * Shared date helpers for billing mappers.
 *
 * TypeORM `date` columns return PG values to Node as either ISO-date strings
 * (`'YYYY-MM-DD'`) or, when the driver flips through pg-types, JS `Date`.
 * Domain code expects `Date` (UTC midnight) so it can call `getUTC*`
 * accessors. Use `toDate` / `toDateOrNull` to normalise reads, and
 * `toIsoDate` to emit the canonical write shape.
 */

export function toDate(raw: Date | string): Date {
  if (raw instanceof Date) return raw;
  return new Date(`${raw}T00:00:00.000Z`);
}

export function toDateOrNull(
  raw: Date | string | null | undefined,
): Date | null {
  if (raw == null) return null;
  return toDate(raw);
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function toIsoDateOrNull(d: Date | null): string | null {
  return d == null ? null : toIsoDate(d);
}
