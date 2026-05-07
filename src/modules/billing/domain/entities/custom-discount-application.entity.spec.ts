import { CustomDiscountAmountInvalidError } from '../errors/custom-discount-amount-invalid.error';
import {
  CustomDiscountApplication,
  CustomDiscountApplicationState,
} from './custom-discount-application.entity';

const NOW = new Date('2026-05-07T10:00:00Z');

function makeState(
  overrides: Partial<CustomDiscountApplicationState> = {},
): CustomDiscountApplicationState {
  return {
    id: 'cda-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    customDiscountId: 'cd-uuid-0001',
    invoiceId: 'inv-uuid-0001',
    invoiceLineItemId: null,
    childId: 'child-uuid-0001',
    amountApplied: 5_000,
    appliedAt: NOW,
    ...overrides,
  };
}

describe('CustomDiscountApplication domain entity', () => {
  it('throws CustomDiscountAmountInvalidError when amountApplied is zero', () => {
    expect(() =>
      CustomDiscountApplication.fromState(makeState({ amountApplied: 0 })),
    ).toThrow(CustomDiscountAmountInvalidError);
  });

  it('throws CustomDiscountAmountInvalidError when amountApplied is negative', () => {
    expect(() =>
      CustomDiscountApplication.fromState(makeState({ amountApplied: -1 })),
    ).toThrow(CustomDiscountAmountInvalidError);
  });

  it('roundtrips state through fromState/toState', () => {
    const s = makeState({ invoiceLineItemId: 'li-uuid-0001' });
    const a = CustomDiscountApplication.fromState(s);
    expect(a.toState()).toEqual(s);
    expect(a.id).toBe('cda-uuid-0001');
    expect(a.amountApplied).toBe(5_000);
    expect(a.invoiceLineItemId).toBe('li-uuid-0001');
  });
});
