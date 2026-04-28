import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { KindergartenSlug } from './kindergarten-slug.vo';

describe('KindergartenSlug', () => {
  it.each(['solnyshko', 'kg-1', 'a', 'sun-1-2-3'])(
    'parses valid slug %s',
    (raw) => {
      expect(KindergartenSlug.parse(raw).toString()).toBe(raw);
    },
  );

  it.each(['', 'BAD', 'has space', '-leading', 'trailing-', 'double--hyphen'])(
    'rejects invalid slug %s',
    (raw) => {
      expect(() => KindergartenSlug.parse(raw)).toThrow(
        InvariantViolationError,
      );
    },
  );

  it('rejects slug longer than 64 chars', () => {
    expect(() => KindergartenSlug.parse('a'.repeat(65))).toThrow(
      InvariantViolationError,
    );
  });

  it('equals compares value', () => {
    expect(
      KindergartenSlug.parse('a').equals(KindergartenSlug.parse('a')),
    ).toBe(true);
    expect(
      KindergartenSlug.parse('a').equals(KindergartenSlug.parse('b')),
    ).toBe(false);
  });
});
