import { Locale } from '../value-objects/locale.vo';

export type I18nJsonb = Record<string, string>;

export function localizeJsonb(
  jsonb: I18nJsonb | null | undefined,
  locale: Locale,
  fallback = 'ru',
): string {
  if (!jsonb) return '';
  const key = locale.toString();
  return jsonb[key] ?? jsonb[fallback] ?? Object.values(jsonb)[0] ?? '';
}
