import { InvariantViolationError } from '@/shared-kernel/domain/errors';

const SLUG_RE = /^[a-z0-9](-?[a-z0-9])*$/;
const MIN_LEN = 1;
const MAX_LEN = 64;

/**
 * Kindergarten slug — public, URL-safe identifier. Lower-case alphanumerics
 * with single hyphens between segments. Used as the natural key in admin
 * console URLs and SuperAdmin search.
 */
export class KindergartenSlug {
  private constructor(private readonly value: string) {}

  static parse(raw: string): KindergartenSlug {
    if (
      typeof raw !== 'string' ||
      raw.length < MIN_LEN ||
      raw.length > MAX_LEN
    ) {
      throw new InvariantViolationError(
        'kindergarten slug length must be 1..64',
      );
    }
    if (!SLUG_RE.test(raw)) {
      throw new InvariantViolationError(
        'kindergarten slug must match ^[a-z0-9](-?[a-z0-9])*$',
      );
    }
    return new KindergartenSlug(raw);
  }

  toString(): string {
    return this.value;
  }

  equals(other: KindergartenSlug): boolean {
    return this.value === other.value;
  }
}
