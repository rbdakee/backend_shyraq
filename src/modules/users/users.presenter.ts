import { User } from './domain/entities/user.entity';
import { UserResponseDto } from './dto/user-response.dto';

export const UsersPresenter = {
  user(user: User): UserResponseDto {
    const s = user.toState();
    return {
      id: s.id,
      phone: s.phone,
      full_name: s.fullName,
      avatar_url: s.avatarUrl,
      iin: s.iin,
      date_of_birth:
        s.dateOfBirth !== null
          ? s.dateOfBirth.toISOString().slice(0, 10)
          : null,
      locale: s.locale,
    };
  },
};
