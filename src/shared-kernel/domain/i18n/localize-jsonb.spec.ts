import { localizeJsonb } from './localize-jsonb';
import { Locale } from '../value-objects/locale.vo';

const ru = Locale.parse('ru');
const kk = Locale.parse('kk');

describe('localizeJsonb', () => {
  it('returns value for the requested locale', () => {
    const jsonb = { ru: 'Привет', kk: 'Сәлем' };
    expect(localizeJsonb(jsonb, ru)).toBe('Привет');
    expect(localizeJsonb(jsonb, kk)).toBe('Сәлем');
  });

  it('falls back to "ru" when requested locale is missing', () => {
    const jsonb = { ru: 'Привет' };
    expect(localizeJsonb(jsonb, kk)).toBe('Привет');
  });

  it('falls back to first available value when fallback locale is also missing', () => {
    const jsonb = { kk: 'Сәлем' };
    expect(localizeJsonb(jsonb, kk, 'en')).toBe('Сәлем');
  });

  it('returns empty string for null jsonb', () => {
    expect(localizeJsonb(null, ru)).toBe('');
  });

  it('returns empty string for undefined jsonb', () => {
    expect(localizeJsonb(undefined, ru)).toBe('');
  });

  it('returns empty string for empty object', () => {
    expect(localizeJsonb({}, ru)).toBe('');
  });

  it('uses custom fallback locale when specified', () => {
    const jsonb = { kk: 'Сәлем' };
    expect(localizeJsonb(jsonb, ru, 'kk')).toBe('Сәлем');
  });
});
