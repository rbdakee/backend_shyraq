import { resolveLocale } from './resolve-locale';

describe('resolveLocale', () => {
  it('uses userLocale when valid', () => {
    expect(resolveLocale(undefined, 'kk').toString()).toBe('kk');
  });

  it('uses userLocale over Accept-Language header', () => {
    expect(resolveLocale('kk', 'ru').toString()).toBe('ru');
  });

  it('falls back to Accept-Language when userLocale is invalid', () => {
    expect(resolveLocale('kk', 'en').toString()).toBe('kk');
  });

  it('parses Accept-Language with quality values', () => {
    expect(resolveLocale('kk;q=0.9, ru;q=0.8', undefined).toString()).toBe(
      'kk',
    );
  });

  it('parses Accept-Language with region subtag', () => {
    expect(resolveLocale('ru-RU', undefined).toString()).toBe('ru');
  });

  it('falls back to default when userLocale and Accept-Language are both invalid', () => {
    expect(resolveLocale('en-US', 'en').toString()).toBe('ru');
  });

  it('falls back to default when all inputs are undefined', () => {
    expect(resolveLocale(undefined, undefined).toString()).toBe('ru');
  });

  it('falls back to default for empty userLocale', () => {
    expect(resolveLocale(undefined, '').toString()).toBe('ru');
  });
});
