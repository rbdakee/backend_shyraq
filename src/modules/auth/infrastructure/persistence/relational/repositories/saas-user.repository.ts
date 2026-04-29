import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { SaasUser } from '../../../../domain/entities/saas-user.entity';
import { SaasUserRepository } from '../../saas-user.repository';
import { SaasUserEntity } from '../entities/saas-user.entity';
import { SaasUserMapper } from '../mappers/saas-user.mapper';

@Injectable()
export class SaasUserRelationalRepository extends SaasUserRepository {
  constructor(
    @InjectRepository(SaasUserEntity)
    private readonly repo: Repository<SaasUserEntity>,
  ) {
    super();
  }

  async findById(id: string): Promise<SaasUser | null> {
    const row = await this.manager()
      .getRepository(SaasUserEntity)
      .findOne({ where: { id } });
    return row ? SaasUserMapper.toDomain(row) : null;
  }

  async findByEmail(email: string): Promise<SaasUser | null> {
    const row = await this.manager()
      .getRepository(SaasUserEntity)
      .findOne({ where: { email } });
    return row ? SaasUserMapper.toDomain(row) : null;
  }

  async updateLastLogin(id: string, at: Date): Promise<void> {
    await this.manager().update(SaasUserEntity, { id }, { last_login_at: at });
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
