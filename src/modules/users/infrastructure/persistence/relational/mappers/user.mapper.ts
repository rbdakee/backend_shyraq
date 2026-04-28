import { User } from '../../../../domain/entities/user.entity';
import { UserEntity } from '../entities/user.entity';

export class UserMapper {
  static toDomain(entity: UserEntity): User {
    return User.hydrate({
      id: entity.id,
      phone: entity.phone,
      fullName: entity.full_name,
      avatarUrl: entity.avatar_url,
      iin: entity.iin,
      dateOfBirth:
        entity.date_of_birth !== null ? new Date(entity.date_of_birth) : null,
      locale: entity.locale,
    });
  }

  static toPersistence(domain: User): UserEntity {
    const e = new UserEntity();
    const state = domain.toState();
    e.id = state.id;
    e.phone = state.phone;
    e.full_name = state.fullName;
    e.avatar_url = state.avatarUrl;
    e.iin = state.iin;
    e.date_of_birth =
      state.dateOfBirth !== null
        ? state.dateOfBirth.toISOString().slice(0, 10)
        : null;
    e.locale = state.locale === 'kk' ? 'kk' : 'ru';
    return e;
  }
}
