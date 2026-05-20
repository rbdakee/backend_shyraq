import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AllConfigType } from '@/config/config.type';
import { RedisModule } from '@/redis/redis.module';
import { UsersModule } from '@/modules/users/users.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { ChildModule } from '@/modules/child/child.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BcryptPasswordHasherAdapter } from './infrastructure/adapters/bcrypt-password-hasher.adapter';
import { JsonwebtokenJwtAdapter } from './infrastructure/adapters/jsonwebtoken-jwt.adapter';
import { MockSmsAdapter } from './infrastructure/adapters/mock-sms.adapter';
import { WhatsAppCloudSmsAdapter } from './infrastructure/adapters/whatsapp-cloud-sms.adapter';
import { RefreshTokenEntity } from './infrastructure/persistence/relational/entities/refresh-token.entity';
import { SaasRefreshTokenEntity } from './infrastructure/persistence/relational/entities/saas-refresh-token.entity';
import { SaasUserEntity } from './infrastructure/persistence/relational/entities/saas-user.entity';
import { RefreshTokenRelationalRepository } from './infrastructure/persistence/relational/repositories/refresh-token.repository';
import { SaasRefreshTokenRelationalRepository } from './infrastructure/persistence/relational/repositories/saas-refresh-token.repository';
import { SaasUserRelationalRepository } from './infrastructure/persistence/relational/repositories/saas-user.repository';
import { RedisOtpStoreAdapter } from './infrastructure/redis/redis-otp-store.adapter';
import { RedisTokenBlocklistAdapter } from './infrastructure/redis/redis-token-blocklist.adapter';
import { JwtTokenPort } from './jwt-token.port';
import { OtpStorePort } from './otp-store.port';
import { PasswordHasherPort } from './password-hasher.port';
import { RefreshTokenRepository } from './infrastructure/persistence/refresh-token.repository';
import { SaasRefreshTokenRepository } from './infrastructure/persistence/saas-refresh-token.repository';
import { SaasUserRepository } from './infrastructure/persistence/saas-user.repository';
import { SmsPort } from './sms.port';
import { SuperAdminAuthController } from './super-admin-auth.controller';
import {
  TokenBlocklistEventsPort,
  TokenBlocklistPort,
} from './token-blocklist.port';

@Global()
@Module({
  imports: [
    ConfigModule,
    RedisModule,
    UsersModule,
    StaffModule,
    ChildModule,
    TypeOrmModule.forFeature([
      RefreshTokenEntity,
      SaasRefreshTokenEntity,
      SaasUserEntity,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        secret: configService.getOrThrow('auth.jwtAccessSecret', {
          infer: true,
        }),
        signOptions: {
          expiresIn: configService.getOrThrow('auth.jwtAccessTtl', {
            infer: true,
          }),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, SuperAdminAuthController],
  providers: [
    AuthService,
    {
      provide: SmsPort,
      inject: [ConfigService],
      useFactory: (cs: ConfigService<AllConfigType>) => {
        const provider = cs.getOrThrow('auth.smsProvider', { infer: true });
        if (provider === 'whatsapp') {
          const cfg = cs.getOrThrow('auth.whatsapp', { infer: true });
          if (!cfg) {
            throw new Error(
              'SMS_PROVIDER=whatsapp but auth.whatsapp config is null',
            );
          }
          return new WhatsAppCloudSmsAdapter(cfg);
        }
        return new MockSmsAdapter();
      },
    },
    { provide: JwtTokenPort, useClass: JsonwebtokenJwtAdapter },
    { provide: PasswordHasherPort, useClass: BcryptPasswordHasherAdapter },
    { provide: OtpStorePort, useClass: RedisOtpStoreAdapter },
    RedisTokenBlocklistAdapter,
    { provide: TokenBlocklistPort, useExisting: RedisTokenBlocklistAdapter },
    {
      provide: TokenBlocklistEventsPort,
      useExisting: RedisTokenBlocklistAdapter,
    },
    {
      provide: RefreshTokenRepository,
      useClass: RefreshTokenRelationalRepository,
    },
    {
      provide: SaasRefreshTokenRepository,
      useClass: SaasRefreshTokenRelationalRepository,
    },
    {
      provide: SaasUserRepository,
      useClass: SaasUserRelationalRepository,
    },
  ],
  exports: [
    AuthService,
    JwtTokenPort,
    TokenBlocklistPort,
    TokenBlocklistEventsPort,
    JwtModule,
    SmsPort,
    OtpStorePort,
    RefreshTokenRepository,
  ],
})
export class AuthModule {}
