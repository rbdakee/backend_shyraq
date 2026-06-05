import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '@/redis/redis.service';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  KASPI_VERSION_HEALTH_REDIS_KEY,
  KaspiVersionHealthSnapshot,
} from './kaspi-version-health.constants';
import { KaspiVersionProbeService } from './kaspi-version-probe.service';

export { KASPI_VERSION_HEALTH_REDIS_KEY };

/** Default cron expression: every 15 minutes. Env-overridable. */
export const KASPI_VERSION_HEALTH_CRON_EXPRESSION =
  process.env.KASPI_VERSION_HEALTH_CRON_EXPRESSION ?? '*/15 * * * *';

/**
 * TTL for the cached snapshot. A long-dead / never-run cron lets the key
 * expire, so `/health/ready` surfaces `unknown` (stale) rather than a
 * forever-green value. Default 1h.
 */
const KASPI_VERSION_HEALTH_TTL_SECONDS = Number.parseInt(
  process.env.KASPI_VERSION_HEALTH_TTL_SECONDS ?? '3600',
  10,
);

/**
 * KaspiVersionHealthService (B24 K9).
 *
 * SMS-free version-gate health cron. Periodically probes the configured
 * `app_build` against Kaspi's gate and caches the result in Redis so the
 * API's `GET /api/v1/health/ready` can surface it as `checks.kaspi`
 * (INFORMATIONAL — never affects the top-level `status`/k8s readiness).
 *
 * The cron only fires in the API process — `NestScheduleModule.forRoot()`
 * is wired ONLY in `AppModule`, not the worker. It is OPT-IN via
 * `KASPI_VERSION_HEALTH_CRON=enabled` (default OFF) so unit/e2e suites that
 * boot AppModule do not fire live Kaspi probes. Shared Redis lets multiple
 * API replicas converge on a single cached value.
 */
@Injectable()
export class KaspiVersionHealthService {
  private readonly logger = new Logger(KaspiVersionHealthService.name);

  constructor(
    private readonly probeService: KaspiVersionProbeService,
    private readonly redis: RedisService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Cron(KASPI_VERSION_HEALTH_CRON_EXPRESSION, {
    name: 'kaspi:version-health',
  })
  async runProbe(): Promise<void> {
    if (process.env.KASPI_VERSION_HEALTH_CRON !== 'enabled') {
      this.logger.log(
        'Kaspi version-health cron skipped (KASPI_VERSION_HEALTH_CRON != enabled)',
      );
      return;
    }

    let result: Awaited<ReturnType<KaspiVersionProbeService['probe']>>;
    try {
      result = await this.probeService.probe();
    } catch (err) {
      // A Kaspi/network outage must NOT flip the gate to "blocked". We leave
      // the previous snapshot (or absence thereof) untouched — only a
      // definitive `OldVersionToUpdate` means blocked. Never throw out.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Kaspi version-health probe failed; cached snapshot left unchanged: ${message}`,
      );
      return;
    }

    const snapshot: KaspiVersionHealthSnapshot = {
      build: result.build,
      accepted: result.accepted,
      alarm: result.alarm ?? null,
      checkedAt: this.clock.now().toISOString(),
    };

    try {
      await this.redis.set(
        KASPI_VERSION_HEALTH_REDIS_KEY,
        JSON.stringify(snapshot),
        'EX',
        KASPI_VERSION_HEALTH_TTL_SECONDS,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Kaspi version-health snapshot write failed: ${message}`,
      );
    }
  }
}
