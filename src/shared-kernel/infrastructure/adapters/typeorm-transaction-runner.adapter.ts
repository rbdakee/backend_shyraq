import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TransactionRunnerPort } from '../../application/ports/transaction-runner.port';

/**
 * Relational adapter for `TransactionRunnerPort`. Wraps the application's
 * default `DataSource.transaction(cb)` so callers don't have to import
 * TypeORM concretes from service code. The callback receives the
 * transaction-bound `EntityManager`; the underlying TX commits on resolve
 * and rolls back on throw — standard TypeORM semantics.
 *
 * Registered globally in `SharedKernelModule` so every business module sees
 * the same singleton without per-module re-wiring.
 */
@Injectable()
export class TypeOrmTransactionRunnerAdapter extends TransactionRunnerPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    super();
  }

  run<T>(cb: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(cb);
  }
}
