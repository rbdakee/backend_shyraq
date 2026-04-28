import { Injectable } from '@nestjs/common';
import { User } from './domain/entities/user.entity';
import { UserNotFoundError } from './domain/errors/user-not-found.error';
import { UserRepository, UserUpdateInput } from './user.repository';

export interface UpdateMeInput {
  fullName?: string;
  avatarUrl?: string | null;
  iin?: string | null;
  dateOfBirth?: Date | null;
  locale?: string;
}

/**
 * UsersService — application layer for /users/me. Users are a shared identity
 * (one phone -> N kindergarten roles), so this service is intentionally
 * tenant-agnostic. It does not enforce kindergarten scope; the caller is
 * always the user themselves (resolved from JWT.sub).
 */
@Injectable()
export class UsersService {
  constructor(private readonly users: UserRepository) {}

  async findById(userId: string): Promise<User | null> {
    return this.users.findById(userId);
  }

  async getMe(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UserNotFoundError(userId);
    }
    return user;
  }

  async updateMe(userId: string, input: UpdateMeInput): Promise<User> {
    const changes: UserUpdateInput = {};
    if (input.fullName !== undefined) changes.fullName = input.fullName;
    if (input.avatarUrl !== undefined) changes.avatarUrl = input.avatarUrl;
    if (input.iin !== undefined) changes.iin = input.iin;
    if (input.dateOfBirth !== undefined)
      changes.dateOfBirth = input.dateOfBirth;
    if (input.locale !== undefined) changes.locale = input.locale;
    return this.users.update(userId, changes);
  }
}
