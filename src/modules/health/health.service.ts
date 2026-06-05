import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DatabasePingPort } from '@/shared-kernel/application/ports/database-ping.port';
// Import ONLY the dependency-free key constant + snapshot type from the
// billing module. The constants file has no NestJS/Kaspi-HTTP deps, so this
// does NOT create a HealthModule → BillingModule import cycle.
import {
  KASPI_VERSION_HEALTH_REDIS_KEY,
  KaspiVersionHealthSnapshot,
} from '@/modules/billing/kaspi-version-health.constants';
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
    const [db, redis, kaspiSnapshot] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.readKaspiSnapshot(),
    ]);

    const kaspi = this.mapKaspi(kaspiSnapshot);

    return {
      // CRITICAL: top-level status is driven ONLY by db + redis. A Kaspi
      // gate-block (kaspi='down') is INFORMATIONAL and must NOT pull a
      // healthy API out of k8s rotation.
      status: db === 'up' && redis === 'up' ? 'ok' : 'degraded',
      checks: { db, redis, kaspi },
      ...(kaspiSnapshot
        ? {
            kaspi_detail: {
              build: kaspiSnapshot.build,
              checked_at: kaspiSnapshot.checkedAt,
            },
          }
        : {}),
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

  /**
   * Reads the cached Kaspi version-gate health snapshot produced by the K9
   * cron. Returns null when missing/unreadable/unparseable — the caller maps
   * that to `unknown`.
   */
  private async readKaspiSnapshot(): Promise<KaspiVersionHealthSnapshot | null> {
    try {
      const raw = await this.redis.get(KASPI_VERSION_HEALTH_REDIS_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as KaspiVersionHealthSnapshot;
      if (typeof parsed?.accepted !== 'boolean') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private mapKaspi(
    snapshot: KaspiVersionHealthSnapshot | null,
  ): 'up' | 'down' | 'unknown' {
    if (!snapshot) {
      return 'unknown';
    }
    if (
      snapshot.alarm === 'OldVersionToUpdate' ||
      snapshot.accepted === false
    ) {
      return 'down';
    }
    return snapshot.accepted === true ? 'up' : 'unknown';
  }
}
