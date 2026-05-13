import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DatabasePingPort } from '@/shared-kernel/application/ports/database-ping.port';
import { HealthReadyDto, HealthStatusDto } from './dto/health-status.dto';

@Injectable()
export class HealthService {
  constructor(
    private readonly clock: ClockPort,
    private readonly dbPing: DatabasePingPort,
    private readonly redis: RedisService,
  ) {}

  getStatus(): HealthStatusDto {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.1',
      uptime_seconds: process.uptime(),
      timestamp: this.clock.now().toISOString(),
    };
  }

  async getReadiness(): Promise<HealthReadyDto> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);

    return {
      status: db === 'up' && redis === 'up' ? 'ok' : 'degraded',
      checks: { db, redis },
    };
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.dbPing.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
