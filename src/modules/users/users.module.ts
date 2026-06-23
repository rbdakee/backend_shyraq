import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '@/shared-kernel/storage/storage.module';
import { UserEntity } from './infrastructure/persistence/relational/entities/user.entity';
import { UserRelationalRepository } from './infrastructure/persistence/relational/repositories/user.repository';
import { UserRepository } from './infrastructure/persistence/user.repository';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), StorageModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: UserRepository, useClass: UserRelationalRepository },
  ],
  exports: [UsersService, UserRepository],
})
export class UsersModule {}
