import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { AllConfigType } from '@/config/config.type';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(configService: ConfigService<AllConfigType>) {
    const password = configService.get('redis.password', { infer: true });
    super({
      host: configService.getOrThrow('redis.host', { infer: true }),
      port: configService.getOrThrow('redis.port', { infer: true }),
      password: password ? password : undefined,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });

    this.on('connect', () => this.logger.log('Redis connected'));
    this.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit().catch(() => this.disconnect());
    this.logger.log('Redis disconnected');
  }
}
