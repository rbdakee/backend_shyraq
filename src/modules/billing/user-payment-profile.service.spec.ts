import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { User } from '@/modules/users/domain/entities/user.entity';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { UserPaymentProfile } from './domain/entities/user-payment-profile.entity';
import { UserPaymentProfileRepository } from './infrastructure/persistence/user-payment-profile.repository';
import { UserPaymentProfileService } from './user-payment-profile.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-06T08:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

class ProfileRepo extends UserPaymentProfileRepository {
  row: UserPaymentProfile | null = null;

  findByUserId(userId: string): Promise<UserPaymentProfile | null> {
    return Promise.resolve(this.row?.userId === userId ? this.row : null);
  }

  save(profile: UserPaymentProfile): Promise<UserPaymentProfile> {
    this.row = profile;
    return Promise.resolve(profile);
  }

  deleteByUserId(userId: string): Promise<boolean> {
    const found = this.row?.userId === userId;
    if (found) this.row = null;
    return Promise.resolve(found);
  }
}

class UsersRepo extends UserRepository {
  findById(id: string): Promise<User | null> {
    return Promise.resolve(
      id === USER_ID
        ? User.hydrate({
            id,
            phone: '+77001234567',
            fullName: 'Parent',
            avatarUrl: null,
            iin: null,
            dateOfBirth: null,
            locale: 'ru',
          })
        : null,
    );
  }
  findByPhone(): Promise<User | null> {
    return Promise.resolve(null);
  }
  upsertByPhone(): Promise<User> {
    throw new Error('not used');
  }
  update(): Promise<User> {
    throw new Error('not used');
  }
}

describe('UserPaymentProfileService', () => {
  let profiles: ProfileRepo;
  let service: UserPaymentProfileService;

  beforeEach(() => {
    profiles = new ProfileRepo();
    service = new UserPaymentProfileService(
      profiles,
      new UsersRepo(),
      new FixedClock(),
    );
  });

  it('falls back to the login phone without creating a saved profile', async () => {
    await expect(service.get(USER_ID)).resolves.toEqual({
      billingPhone: '+77001234567',
      billingAddress: null,
      saved: false,
    });
    expect(profiles.row).toBeNull();
  });

  it('saves and replaces both billing fields atomically', async () => {
    await service.save(USER_ID, '+77011234567', ' Алматы, Абая 1 ');
    await service.save(USER_ID, '+77771234567', 'Астана, Достык 2');

    await expect(service.get(USER_ID)).resolves.toEqual({
      billingPhone: '+77771234567',
      billingAddress: 'Астана, Достык 2',
      saved: true,
    });
  });

  it('deletes both saved values and restores the login-phone fallback', async () => {
    await service.save(USER_ID, '+77011234567', 'Алматы');
    await service.delete(USER_ID);

    await expect(service.get(USER_ID)).resolves.toMatchObject({
      billingPhone: '+77001234567',
      billingAddress: null,
      saved: false,
    });
  });
});
