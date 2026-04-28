import { User } from './user.entity';

describe('User domain entity', () => {
  const baseState = {
    id: 'user-1',
    phone: '+77001234567',
    fullName: 'Айгуль',
    avatarUrl: null,
    iin: null,
    dateOfBirth: null,
    locale: 'ru',
  };

  it('hydrate exposes immutable identity (id, phone) and getters for mutables', () => {
    const u = User.hydrate(baseState);
    expect(u.id).toBe('user-1');
    expect(u.phone).toBe('+77001234567');
    expect(u.fullName).toBe('Айгуль');
    expect(u.avatarUrl).toBeNull();
    expect(u.iin).toBeNull();
    expect(u.dateOfBirth).toBeNull();
    expect(u.locale).toBe('ru');
  });

  it('toState() round-trips via hydrate()', () => {
    const original = User.hydrate(baseState);
    const reconstructed = User.hydrate(original.toState());
    expect(reconstructed.toState()).toEqual(baseState);
  });
});
