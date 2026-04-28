import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { UserRepository, UserUpdateInput } from '../../../../user.repository';
import { User } from '../../../../domain/entities/user.entity';
import { UserNotFoundError } from '../../../../domain/errors/user-not-found.error';
import { IinAlreadyTakenError } from '../../../../domain/errors/iin-already-taken.error';
import { ProfileUniqueViolationError } from '../../../../domain/errors/profile-unique-violation.error';
import { UserEntity } from '../entities/user.entity';
import { UserMapper } from '../mappers/user.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
  detail?: string;
}

const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class UserRelationalRepository extends UserRepository {
  constructor(
    @InjectRepository(UserEntity)
    private readonly repo: Repository<UserEntity>,
  ) {
    super();
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.manager()
      .getRepository(UserEntity)
      .findOne({ where: { id } });
    return row ? UserMapper.toDomain(row) : null;
  }

  async findByPhone(phone: string): Promise<User | null> {
    const row = await this.manager()
      .getRepository(UserEntity)
      .findOne({ where: { phone } });
    return row ? UserMapper.toDomain(row) : null;
  }

  async upsertByPhone(phone: string): Promise<User> {
    const manager = this.manager();
    return manager.transaction(async (tx) => {
      const existing = await tx
        .getRepository(UserEntity)
        .findOne({ where: { phone } });
      if (existing) {
        await tx.update(
          UserEntity,
          { id: existing.id },
          { last_login_at: new Date() },
        );
        return UserMapper.toDomain(existing);
      }
      const insertResult = await tx.insert(UserEntity, {
        phone,
        full_name: phone,
      });
      const id = insertResult.identifiers[0].id as string;
      const created = await tx
        .getRepository(UserEntity)
        .findOneOrFail({ where: { id } });
      return UserMapper.toDomain(created);
    });
  }

  async update(id: string, changes: UserUpdateInput): Promise<User> {
    const manager = this.manager();
    const repo = manager.getRepository(UserEntity);
    const data: Partial<UserEntity> = {};
    if (changes.fullName !== undefined) data.full_name = changes.fullName;
    if (changes.avatarUrl !== undefined) data.avatar_url = changes.avatarUrl;
    if (changes.iin !== undefined) data.iin = changes.iin;
    if (changes.dateOfBirth !== undefined)
      data.date_of_birth =
        changes.dateOfBirth !== null
          ? changes.dateOfBirth.toISOString().slice(0, 10)
          : null;
    if (changes.locale !== undefined)
      data.locale = changes.locale === 'kk' ? 'kk' : 'ru';

    try {
      const result = await repo.update({ id }, data);
      if (result.affected === 0) {
        throw new UserNotFoundError(id);
      }
      const row = await repo.findOneOrFail({ where: { id } });
      return UserMapper.toDomain(row);
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (pg?.code === PG_UNIQUE_VIOLATION) {
          const target = pg.constraint ?? '';
          const detail = pg.detail ?? '';
          if (target.includes('iin') || detail.includes('(iin)')) {
            throw new IinAlreadyTakenError();
          }
          throw new ProfileUniqueViolationError();
        }
      }
      throw err;
    }
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
