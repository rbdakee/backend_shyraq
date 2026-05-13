import { maskKzPhone } from './phone-mask';

/**
 * B22a T8 / FINDINGS B11 H4 — masking contract for list-shaped
 * pickup-request responses.
 */
describe('maskKzPhone', () => {
  it('masks a canonical KZ E.164 phone to `+7***LAST4`', () => {
    expect(maskKzPhone('+77071234567')).toBe('+7***4567');
  });

  it('masks a different KZ phone preserving its own last-4', () => {
    expect(maskKzPhone('+77019988770')).toBe('+7***8770');
  });

  it('returns `***LAST4` for too-short input that is not canonical KZ', () => {
    // 6 chars, doesn't match `+7\d{10}` → best-effort tail mask.
    expect(maskKzPhone('+77012')).toBe('***7012');
  });

  it('returns `***` when input is shorter than 4 characters', () => {
    expect(maskKzPhone('123')).toBe('***');
  });

  it('returns empty string for empty input (preserves caller truthiness)', () => {
    expect(maskKzPhone('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(maskKzPhone('   ')).toBe('');
  });

  it('returns `***` for non-string input (defensive type-cast)', () => {
    // Hostile callers — `as unknown as string` mirrors what TS would
    // reject but JS would happily forward.
    expect(maskKzPhone(undefined as unknown as string)).toBe('***');
    expect(maskKzPhone(null as unknown as string)).toBe('***');
    expect(maskKzPhone(12345 as unknown as string)).toBe('***');
  });

  it('falls back to tail-mask for foreign-format numbers (no leading +7)', () => {
    // `+1` US format — not KZ canonical so tail-mask applies.
    expect(maskKzPhone('+15551234567')).toBe('***4567');
  });

  it('does not leak inner digits — never returns the input unchanged', () => {
    const phone = '+77071234567';
    expect(maskKzPhone(phone)).not.toBe(phone);
    expect(maskKzPhone(phone)).not.toContain('707123');
  });
});
