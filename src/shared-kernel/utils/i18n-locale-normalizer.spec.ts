import { normalizeLegacyKzLocale } from './i18n-locale-normalizer';

describe('normalizeLegacyKzLocale', () => {
  it('returns null / undefined / primitives unchanged', () => {
    expect(normalizeLegacyKzLocale(null)).toBeNull();
    expect(normalizeLegacyKzLocale(undefined)).toBeUndefined();
    expect(normalizeLegacyKzLocale('hello')).toBe('hello');
    expect(normalizeLegacyKzLocale(42)).toBe(42);
  });

  it('returns arrays unchanged', () => {
    const arr = ['ru', 'kk'];
    expect(normalizeLegacyKzLocale(arr)).toBe(arr);
  });

  it('returns an object without `kz` unchanged', () => {
    const input = { ru: 'Привет', kk: 'Сәлем' };
    expect(normalizeLegacyKzLocale(input)).toBe(input);
  });

  it('rewrites a legacy `kz` payload into `kk`', () => {
    const input = { ru: 'Привет', kz: 'Сәлем' };
    const out = normalizeLegacyKzLocale(input);
    expect(out).toEqual({ ru: 'Привет', kk: 'Сәлем' });
    expect(out).not.toHaveProperty('kz');
  });

  it('drops legacy `kz` when explicit `kk` is already present', () => {
    const input = { ru: 'Привет', kk: 'Жаңа', kz: 'Ескі' };
    const out = normalizeLegacyKzLocale(input);
    expect(out).toEqual({ ru: 'Привет', kk: 'Жаңа' });
  });

  it('keeps unrelated keys (en, fr, …) intact', () => {
    const input = { ru: 'Привет', kz: 'Сәлем', en: 'Hi' };
    const out = normalizeLegacyKzLocale(input);
    expect(out).toEqual({ ru: 'Привет', kk: 'Сәлем', en: 'Hi' });
  });
});
