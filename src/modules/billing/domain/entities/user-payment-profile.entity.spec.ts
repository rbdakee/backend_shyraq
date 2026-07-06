import {
  UserPaymentProfile,
  UserPaymentProfileState,
} from './user-payment-profile.entity';

const CREATED_AT = new Date('2026-07-03T08:00:00.000Z');

function makeState(): UserPaymentProfileState {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    billingPhone: '+77001234567',
    billingAddress: 'Алматы, Абая 1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe('UserPaymentProfile domain entity', () => {
  it('round-trips profile state', () => {
    const state = makeState();
    expect(UserPaymentProfile.fromState(state).toState()).toEqual(state);
  });

  it('updates billing details atomically', () => {
    const profile = UserPaymentProfile.fromState(makeState());
    const updatedAt = new Date('2026-07-03T09:00:00.000Z');

    profile.update('+77771234567', 'Астана, Достык 2', updatedAt);

    expect(profile.billingPhone).toBe('+77771234567');
    expect(profile.billingAddress).toBe('Астана, Достык 2');
    expect(profile.updatedAt).toEqual(updatedAt);
    expect(profile.userId).toBe(makeState().userId);
  });
});
