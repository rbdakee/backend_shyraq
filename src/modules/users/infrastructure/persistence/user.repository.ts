import { User } from '../../domain/entities/user.entity';

export interface UserUpdateInput {
  fullName?: string;
  avatarUrl?: string | null;
  iin?: string | null;
  dateOfBirth?: Date | null;
  locale?: string;
}

export abstract class UserRepository {
  abstract findById(id: string): Promise<User | null>;
  /**
   * Used by AddChildGuardianUseCase to short-circuit the find-or-create
   * user-by-phone flow without writing (upsertByPhone always touches
   * lastLoginAt).
   */
  abstract findByPhone(phone: string): Promise<User | null>;
  abstract upsertByPhone(phone: string): Promise<User>;
  abstract update(id: string, changes: UserUpdateInput): Promise<User>;
}
