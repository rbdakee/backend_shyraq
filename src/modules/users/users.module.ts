import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './infrastructure/persistence/relational/entities/user.entity';
import { UserRelationalRepository } from './infrastructure/persistence/relational/repositories/user.repository';
import { UserRepository } from './user.repository';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: UserRepository, useClass: UserRelationalRepository },
  ],
  exports: [UsersService, UserRepository],
})
export class UsersModule {}
