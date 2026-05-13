import { Global, Module } from '@nestjs/common';
import { ClockPort } from './application/ports/clock.port';
import { DatabasePingPort } from './application/ports/database-ping.port';
import { TransactionRunnerPort } from './application/ports/transaction-runner.port';
import { SystemClockAdapter } from './infrastructure/adapters/system-clock.adapter';
import { TypeOrmDatabasePingAdapter } from './infrastructure/adapters/typeorm-database-ping.adapter';
import { TypeOrmTransactionRunnerAdapter } from './infrastructure/adapters/typeorm-transaction-runner.adapter';

/**
 * Shared kernel — providers that every other module can depend on without
 * importing this module explicitly. Currently:
 *   - ClockPort (system clock)
 *   - TransactionRunnerPort (TypeORM-backed atomic unit of work)
 *   - DatabasePingPort (readiness `SELECT 1`)
 *
 * `NotificationPort` is now wired by `NotificationModule` (which is also
 * `@Global()`) — it binds the real outbox-backed adapter and re-exports the
 * port. SharedKernelModule no longer provides a default fallback.
 */
@Global()
@Module({
  providers: [
    { provide: ClockPort, useClass: SystemClockAdapter },
    {
      provide: TransactionRunnerPort,
      useClass: TypeOrmTransactionRunnerAdapter,
    },
    { provide: DatabasePingPort, useClass: TypeOrmDatabasePingAdapter },
  ],
  exports: [ClockPort, TransactionRunnerPort, DatabasePingPort],
})
export class SharedKernelModule {}
