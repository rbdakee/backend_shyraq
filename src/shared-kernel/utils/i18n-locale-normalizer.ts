/**
 * `normalizeLegacyKzLocale` — backward-compat shim for the B22b T1 i18n
 * key sweep. Until B22b, parts of the codebase (billing/content/holiday
 * DTOs and the birthday template builder) used `kz` for Kazakh — the
 * country-code TLD — while the notification dispatcher used the
 * BCP-47-correct `kk`. B22b standardises on `kk` everywhere, but for
 * one release we still accept inbound payloads that carry only `kz`.
 *
 * Behaviour:
 *   - If the value is not a plain object → return as-is.
 *   - If `kk` is already set → no change (the explicit `kk` wins).
 *   - If `kz` is set and `kk` is absent → copy `kz` to `kk` and remove
 *     the `kz` key, so downstream code only sees the canonical key.
 *
 * Used as a `class-transformer` `@Transform` callback on i18n-shaped
 * DTO fields. Safe to call on `undefined` / `null` / non-object values.
 *
 * The fallback is scheduled to be removed in B23; the same shape is
 * applied at the DB layer by the `B22I18nKzToKk` data migration.
 */
export function normalizeLegacyKzLocale<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;

  const obj = value as Record<string, unknown>;
  if (typeof obj.kk === 'string' && obj.kk.length > 0) {
    // Explicit `kk` already present; just strip legacy `kz` if any.
    if ('kz' in obj) {
      const { kz: _kz, ...rest } = obj;
      void _kz;
      return rest as T;
    }
    return value;
  }
  if (typeof obj.kz === 'string') {
    const { kz, ...rest } = obj;
    return { ...rest, kk: kz } as T;
  }
  return value;
}
