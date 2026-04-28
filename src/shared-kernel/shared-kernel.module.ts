import { Global, Module } from '@nestjs/common';
import { LoggingNotificationAdapter } from '@/common/notifications/logging-notification.adapter';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ClockPort } from './application/ports/clock.port';
import { SystemClockAdapter } from './infrastructure/adapters/system-clock.adapter';

/**
 * Shared kernel — providers that every other module can depend on without
 * importing this module explicitly. Currently:
 *   - ClockPort (system clock)
 *   - NotificationPort (logging-only adapter; real fan-out comes later)
 */
@Global()
@Module({
  providers: [
    { provide: ClockPort, useClass: SystemClockAdapter },
    { provide: NotificationPort, useClass: LoggingNotificationAdapter },
  ],
  exports: [ClockPort, NotificationPort],
})
export class SharedKernelModule {}
