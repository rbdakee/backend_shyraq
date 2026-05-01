import { Global, Module } from '@nestjs/common';
import { ClockPort } from './application/ports/clock.port';
import { SystemClockAdapter } from './infrastructure/adapters/system-clock.adapter';

/**
 * Shared kernel — providers that every other module can depend on without
 * importing this module explicitly. Currently:
 *   - ClockPort (system clock)
 *
 * `NotificationPort` is now wired by `NotificationModule` (which is also
 * `@Global()`) — it binds the real outbox-backed adapter and re-exports the
 * port. SharedKernelModule no longer provides a default fallback.
 */
@Global()
@Module({
  providers: [{ provide: ClockPort, useClass: SystemClockAdapter }],
  exports: [ClockPort],
})
export class SharedKernelModule {}
