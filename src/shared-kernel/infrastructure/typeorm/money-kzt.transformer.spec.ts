import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from './money-kzt.transformer';

describe('moneyKztTransformer', () => {
  it('from("1234.56") yields a MoneyKzt of 1234.56', () => {
    const result = moneyKztTransformer.from('1234.56');
    expect(result).toBeInstanceOf(MoneyKzt);
    expect((result as MoneyKzt).toString()).toBe('1234.56');
  });

  it('from("0.00") yields a zero MoneyKzt', () => {
    const result = moneyKztTransformer.from('0.00');
    expect((result as MoneyKzt).isZero()).toBe(true);
  });

  it('from(null) returns null; from(undefined) returns undefined', () => {
    expect(moneyKztTransformer.from(null)).toBeNull();
    expect(moneyKztTransformer.from(undefined)).toBeUndefined();
  });

  it('from coerces a stray number into MoneyKzt (defence-in-depth)', () => {
    const result = moneyKztTransformer.from(99.99 as unknown as string);
    expect((result as MoneyKzt).toString()).toBe('99.99');
  });

  it('to(MoneyKzt) returns a fixed-point 2dp string', () => {
    const v = MoneyKzt.fromKzt(1234.5);
    expect(moneyKztTransformer.to(v)).toBe('1234.50');
  });

  it('to(MoneyKzt.zero()) returns "0.00"', () => {
    expect(moneyKztTransformer.to(MoneyKzt.zero())).toBe('0.00');
  });

  it('to(null) returns null; to(undefined) returns undefined', () => {
    expect(moneyKztTransformer.to(null)).toBeNull();
    expect(moneyKztTransformer.to(undefined)).toBeUndefined();
  });

  it('round-trips: to(from(x)) === x for canonical inputs', () => {
    for (const raw of ['0.00', '1.00', '12345.67', '99999999.99']) {
      const parsed = moneyKztTransformer.from(raw) as MoneyKzt;
      expect(moneyKztTransformer.to(parsed)).toBe(raw);
    }
  });
});
