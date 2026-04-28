import { Locale } from './locale.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('Locale', () => {
  it('parses "ru"', () => {
    const locale = Locale.parse('ru');
    expect(locale.toString()).toBe('ru');
  });

  it('parses "kk"', () => {
    const locale = Locale.parse('kk');
    expect(locale.toString()).toBe('kk');
  });

  it('lowercases input before parsing', () => {
    const locale = Locale.parse('RU');
    expect(locale.toString()).toBe('ru');
  });

  it('throws InvariantViolationError for unsupported locale', () => {
    expect(() => Locale.parse('en')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => Locale.parse('')).toThrow(InvariantViolationError);
  });

  it('default() returns "ru"', () => {
    expect(Locale.default().toString()).toBe('ru');
  });

  it('equals returns true for same locale', () => {
    const a = Locale.parse('kk');
    const b = Locale.parse('kk');
    expect(a.equals(b)).toBe(true);
  });

  it('equals returns false for different locales', () => {
    const a = Locale.parse('ru');
    const b = Locale.parse('kk');
    expect(a.equals(b)).toBe(false);
  });
});
