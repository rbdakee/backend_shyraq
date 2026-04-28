import { Locale } from '../value-objects/locale.vo';

export function resolveLocale(
  acceptLanguageHeader: string | undefined,
  userLocale: string | undefined,
): Locale {
  if (userLocale) {
    try {
      return Locale.parse(userLocale);
    } catch {
      // fall through
    }
  }
  if (acceptLanguageHeader) {
    const first = acceptLanguageHeader
      .split(',')[0]
      ?.split(';')[0]
      ?.trim()
      .split('-')[0];
    if (first) {
      try {
        return Locale.parse(first);
      } catch {
        // fall through
      }
    }
  }
  return Locale.default();
}
