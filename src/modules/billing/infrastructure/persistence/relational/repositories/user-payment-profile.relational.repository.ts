import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPaymentProfile } from '../../../../domain/entities/user-payment-profile.entity';
import { UserPaymentProfileRepository } from '../../user-payment-profile.repository';
import { UserPaymentProfileTypeOrmEntity } from '../entities/user-payment-profile.typeorm.entity';
import { UserPaymentProfileMapper } from '../mappers/user-payment-profile.mapper';

@Injectable()
export class UserPaymentProfileRelationalRepository extends UserPaymentProfileRepository {
  constructor(
    @InjectRepository(UserPaymentProfileTypeOrmEntity)
    private readonly repo: Repository<UserPaymentProfileTypeOrmEntity>,
  ) {
    super();
  }

  async findByUserId(userId: string): Promise<UserPaymentProfile | null> {
    const row = await this.repo.findOne({ where: { userId } });
    return row ? UserPaymentProfileMapper.toDomain(row) : null;
  }

  async save(profile: UserPaymentProfile): Promise<UserPaymentProfile> {
    const state = profile.toState();
    await this.repo.upsert(
      {
        userId: state.userId,
        billingPhone: state.billingPhone,
        billingAddress: state.billingAddress,
        updatedAt: state.updatedAt,
      },
      {
        conflictPaths: ['userId'],
        skipUpdateIfNoValuesChanged: false,
      },
    );

    const row = await this.repo.findOneOrFail({
      where: { userId: state.userId },
    });
    return UserPaymentProfileMapper.toDomain(row);
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    const result = await this.repo.delete({ userId });
    return (result.affected ?? 0) > 0;
  }
}
