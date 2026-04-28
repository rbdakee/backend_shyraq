import { Email } from './email.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('Email', () => {
  it('parses a valid email', () => {
    const email = Email.parse('user@example.com');
    expect(email.toString()).toBe('user@example.com');
  });

  it('trims whitespace', () => {
    const email = Email.parse('  user@example.com  ');
    expect(email.toString()).toBe('user@example.com');
  });

  it('lowercases the email', () => {
    const email = Email.parse('User@Example.COM');
    expect(email.toString()).toBe('user@example.com');
  });

  it('trims and lowercases together', () => {
    const email = Email.parse('  ADMIN@KINDERGARTEN.KZ  ');
    expect(email.toString()).toBe('admin@kindergarten.kz');
  });

  it('throws InvariantViolationError for missing @', () => {
    expect(() => Email.parse('userexample.com')).toThrow(
      InvariantViolationError,
    );
  });

  it('throws InvariantViolationError for missing domain', () => {
    expect(() => Email.parse('user@')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => Email.parse('')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for email with spaces', () => {
    expect(() => Email.parse('user @example.com')).toThrow(
      InvariantViolationError,
    );
  });

  it('equals returns true for same normalized value', () => {
    const a = Email.parse('user@example.com');
    const b = Email.parse('USER@EXAMPLE.COM');
    expect(a.equals(b)).toBe(true);
  });

  it('equals returns false for different values', () => {
    const a = Email.parse('user@example.com');
    const b = Email.parse('other@example.com');
    expect(a.equals(b)).toBe(false);
  });
});
