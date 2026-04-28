import { Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { HealthStatusDto } from './dto/health-status.dto';

@Injectable()
export class HealthService {
  constructor(private readonly clock: ClockPort) {}

  getStatus(): HealthStatusDto {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.1',
      uptime_seconds: process.uptime(),
      timestamp: this.clock.now().toISOString(),
    };
  }
}
