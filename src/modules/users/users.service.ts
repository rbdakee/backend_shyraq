import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { User } from './domain/entities/user.entity';
import { UserNotFoundError } from './domain/errors/user-not-found.error';
import {
  UserRepository,
  UserUpdateInput,
} from './infrastructure/persistence/user.repository';

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
  constructor(
    private readonly users: UserRepository,
    private readonly fileStorage: FileStoragePort,
  ) {}

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

  /**
   * Uploads a profile photo for the calling user and returns the CANONICAL
   * media URL. Does NOT persist it onto the user — the client PATCHes it into
   * /users/me { avatarUrl } afterwards (upload/profile-update stay separate,
   * mirroring POST /admin/content/upload-media).
   *
   * Key is `avatars/<userId>/<uuid><ext>` — NOT kindergarten-scoped, because a
   * user (parent) may be tenant-unscoped. Mimetype is validated at the
   * controller; size is capped via `maxBytes` (5 MB) at the adapter.
   */
  async uploadAvatar(
    userId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ): Promise<{ avatarUrl: string }> {
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('avatar_file_required');
    }
    const ext = (extname(file.originalname || '') || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
    const key = `avatars/${userId}/${randomUUID()}${safeExt}`;
    const result = await this.fileStorage.upload({
      buffer: file.buffer,
      key,
      contentType: file.mimetype.toLowerCase(),
      maxBytes: 5 * 1024 * 1024,
    });
    return { avatarUrl: result.url };
  }
}
