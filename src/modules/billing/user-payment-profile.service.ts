import { Inject, Injectable } from '@nestjs/common';
import { UserNotFoundError } from '@/modules/users/domain/errors/user-not-found.error';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { UserPaymentProfile } from './domain/entities/user-payment-profile.entity';
import { UserPaymentProfileRepository } from './infrastructure/persistence/user-payment-profile.repository';

export interface UserPaymentProfileView {
  billingPhone: string;
  billingAddress: string | null;
  saved: boolean;
}

@Injectable()
export class UserPaymentProfileService {
  constructor(
    private readonly profiles: UserPaymentProfileRepository,
    private readonly users: UserRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async get(userId: string): Promise<UserPaymentProfileView> {
    const saved = await this.profiles.findByUserId(userId);
    if (saved) {
      return {
        billingPhone: saved.billingPhone,
        billingAddress: saved.billingAddress,
        saved: true,
      };
    }

    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);
    return {
      billingPhone: user.phone,
      billingAddress: null,
      saved: false,
    };
  }

  async save(
    userId: string,
    billingPhone: string,
    billingAddress: string,
  ): Promise<UserPaymentProfileView> {
    const existing = await this.profiles.findByUserId(userId);
    const now = this.clock.now();
    const phone = billingPhone.trim();
    const address = billingAddress.trim();
    const profile = existing
      ? existing
      : UserPaymentProfile.fromState({
          userId,
          billingPhone: phone,
          billingAddress: address,
          createdAt: now,
          updatedAt: now,
        });
    if (existing) profile.update(phone, address, now);

    const saved = await this.profiles.save(profile);
    return {
      billingPhone: saved.billingPhone,
      billingAddress: saved.billingAddress,
      saved: true,
    };
  }

  async delete(userId: string): Promise<void> {
    await this.profiles.deleteByUserId(userId);
  }
}
