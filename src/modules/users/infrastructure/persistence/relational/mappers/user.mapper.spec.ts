import { User } from '../../../../domain/entities/user.entity';
import { UserEntity } from '../entities/user.entity';
import { UserMapper } from './user.mapper';

describe('UserMapper', () => {
  function buildEntity(overrides: Partial<UserEntity> = {}): UserEntity {
    const e = new UserEntity();
    e.id = 'user-1';
    e.phone = '+77001234567';
    e.full_name = 'Айгуль Серикова';
    e.avatar_url = null;
    e.iin = '900101400123';
    e.date_of_birth = '1990-01-01';
    e.locale = 'kk';
    e.is_active = true;
    e.last_login_at = null;
    e.created_at = new Date('2024-01-01T00:00:00Z');
    e.updated_at = new Date('2024-01-01T00:00:00Z');
    return Object.assign(e, overrides);
  }

  it('toDomain hydrates User aggregate', () => {
    const domain = UserMapper.toDomain(buildEntity());
    expect(domain).toBeInstanceOf(User);
    expect(domain.id).toBe('user-1');
    expect(domain.phone).toBe('+77001234567');
    expect(domain.fullName).toBe('Айгуль Серикова');
    expect(domain.iin).toBe('900101400123');
    expect(domain.locale).toBe('kk');
    expect(domain.dateOfBirth).toEqual(new Date('1990-01-01'));
  });

  it('toDomain preserves null avatar_url, iin, date_of_birth', () => {
    const domain = UserMapper.toDomain(
      buildEntity({ avatar_url: null, iin: null, date_of_birth: null }),
    );
    expect(domain.avatarUrl).toBeNull();
    expect(domain.iin).toBeNull();
    expect(domain.dateOfBirth).toBeNull();
  });

  it('toPersistence round-trips with toDomain (locale ru fallback)', () => {
    const entity = buildEntity({ locale: 'ru' });
    const back = UserMapper.toPersistence(UserMapper.toDomain(entity));
    expect(back.id).toBe(entity.id);
    expect(back.phone).toBe(entity.phone);
    expect(back.full_name).toBe(entity.full_name);
    expect(back.iin).toBe(entity.iin);
    expect(back.locale).toBe('ru');
    expect(back.date_of_birth).toBe('1990-01-01');
  });

  it('toPersistence narrows arbitrary locale strings to ru fallback', () => {
    const e = buildEntity({ locale: 'en' as 'ru' | 'kk' });
    const back = UserMapper.toPersistence(UserMapper.toDomain(e));
    expect(back.locale).toBe('ru');
  });
});
