import { BadRequestException } from '@nestjs/common';
import {
  FileStoragePort,
  FileStorageUploadInput,
  FileStorageUploadResult,
} from '@/shared-kernel/storage/file-storage.port';
import { User } from './domain/entities/user.entity';
import { UserNotFoundError } from './domain/errors/user-not-found.error';
import {
  UserRepository,
  UserUpdateInput,
} from './infrastructure/persistence/user.repository';
import { UsersService } from './users.service';

class FakeFileStorage extends FileStoragePort {
  lastUpload?: FileStorageUploadInput;
  upload(input: FileStorageUploadInput): Promise<FileStorageUploadResult> {
    this.lastUpload = input;
    return Promise.resolve({
      url: `/api/v1/media/${input.key}`,
      key: input.key,
      bytes: input.buffer.length,
    });
  }
  download(_key: string): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }
  delete(_key: string): Promise<void> {
    return Promise.resolve();
  }
  getSignedUrl(key: string): Promise<string> {
    return Promise.resolve(`/api/v1/media/${key}`);
  }
}

class FakeUserRepo extends UserRepository {
  byId = new Map<string, User>();
  put(u: User): void {
    this.byId.set(u.id, u);
  }
  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByPhone(_phone: string): Promise<User | null> {
    return Promise.resolve(null);
  }
  upsertByPhone(phone: string): Promise<User> {
    const u = User.hydrate({
      id: `user-${phone}`,
      phone,
      fullName: phone,
      avatarUrl: null,
      iin: null,
      dateOfBirth: null,
      locale: 'ru',
    });
    this.put(u);
    return Promise.resolve(u);
  }
  update(id: string, changes: UserUpdateInput): Promise<User> {
    const existing = this.byId.get(id);
    if (!existing) throw new UserNotFoundError(id);
    const state = existing.toState();
    const updated = User.hydrate({
      ...state,
      fullName: changes.fullName ?? state.fullName,
      avatarUrl:
        changes.avatarUrl !== undefined ? changes.avatarUrl : state.avatarUrl,
      iin: changes.iin !== undefined ? changes.iin : state.iin,
      dateOfBirth:
        changes.dateOfBirth !== undefined
          ? changes.dateOfBirth
          : state.dateOfBirth,
      locale: changes.locale ?? state.locale,
    });
    this.put(updated);
    return Promise.resolve(updated);
  }
}

describe('UsersService', () => {
  it('getMe returns the user when present', async () => {
    const repo = new FakeUserRepo();
    repo.put(
      User.hydrate({
        id: 'u-1',
        phone: '+77012345678',
        fullName: 'Aisha',
        avatarUrl: null,
        iin: null,
        dateOfBirth: null,
        locale: 'ru',
      }),
    );
    const svc = new UsersService(repo, new FakeFileStorage());
    const u = await svc.getMe('u-1');
    expect(u.fullName).toBe('Aisha');
  });

  it('getMe throws UserNotFoundError when user does not exist', async () => {
    const svc = new UsersService(new FakeUserRepo(), new FakeFileStorage());
    await expect(svc.getMe('missing')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('updateMe forwards only provided fields', async () => {
    const repo = new FakeUserRepo();
    repo.put(
      User.hydrate({
        id: 'u-1',
        phone: '+77012345678',
        fullName: 'Old Name',
        avatarUrl: null,
        iin: null,
        dateOfBirth: null,
        locale: 'ru',
      }),
    );
    const svc = new UsersService(repo, new FakeFileStorage());
    const updated = await svc.updateMe('u-1', { fullName: 'New Name' });
    expect(updated.fullName).toBe('New Name');
  });

  it('updateMe accepts locale switch from ru to kk', async () => {
    const repo = new FakeUserRepo();
    repo.put(
      User.hydrate({
        id: 'u-1',
        phone: '+77012345678',
        fullName: 'X',
        avatarUrl: null,
        iin: null,
        dateOfBirth: null,
        locale: 'ru',
      }),
    );
    const svc = new UsersService(repo, new FakeFileStorage());
    const updated = await svc.updateMe('u-1', { locale: 'kk' });
    expect(updated.locale).toBe('kk');
  });

  it('uploadAvatar returns the storage url', async () => {
    const storage = new FakeFileStorage();
    const svc = new UsersService(new FakeUserRepo(), storage);
    const { avatarUrl } = await svc.uploadAvatar('u-42', {
      buffer: Buffer.from('fake-bytes'),
      mimetype: 'image/jpeg',
      originalname: 'me.jpg',
    });
    expect(avatarUrl).toMatch(/^\/api\/v1\/media\/avatars\/u-42\/.+\.jpg$/);
  });

  it('uploadAvatar builds an avatars/<userId>/ key and forwards a 5MB cap', async () => {
    const storage = new FakeFileStorage();
    const svc = new UsersService(new FakeUserRepo(), storage);
    await svc.uploadAvatar('u-7', {
      buffer: Buffer.from('bytes'),
      mimetype: 'image/png',
      originalname: 'avatar.PNG',
    });
    expect(storage.lastUpload?.key).toMatch(/^avatars\/u-7\/.+\.png$/);
    expect(storage.lastUpload?.contentType).toBe('image/png');
    expect(storage.lastUpload?.maxBytes).toBe(5 * 1024 * 1024);
  });

  it('uploadAvatar throws on an empty buffer', async () => {
    const svc = new UsersService(new FakeUserRepo(), new FakeFileStorage());
    await expect(
      svc.uploadAvatar('u-1', {
        buffer: Buffer.alloc(0),
        mimetype: 'image/jpeg',
        originalname: 'empty.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
