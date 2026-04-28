import { InvariantViolationError } from '../errors/invariant-violation.error';

type SupportedLocale = 'kk' | 'ru';

const SUPPORTED: readonly SupportedLocale[] = ['kk', 'ru'];

export class Locale {
  private constructor(private readonly value: SupportedLocale) {}

  static parse(raw: string): Locale {
    const normalized = raw.toLowerCase() as SupportedLocale;
    if (!SUPPORTED.includes(normalized)) {
      throw new InvariantViolationError(
        `locale must be one of: ${SUPPORTED.join(', ')}`,
      );
    }
    return new Locale(normalized);
  }

  static default(): Locale {
    return new Locale('ru');
  }

  toString(): string {
    return this.value;
  }

  equals(other: Locale): boolean {
    return this.value === other.value;
  }
}
