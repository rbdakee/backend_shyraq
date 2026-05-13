import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DatabasePingPort } from '../../application/ports/database-ping.port';

/**
 * TypeORM-backed implementation of `DatabasePingPort`. Runs the
 * `SELECT 1` probe inside the default `DataSource` and resolves on
 * success; any failure (connection refused, pool exhausted, RLS
 * misconfiguration) re-throws so the caller (`HealthService`) can flip
 * the readiness check to `'down'`.
 */
@Injectable()
export class TypeOrmDatabasePingAdapter extends DatabasePingPort {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    super();
  }

  async ping(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }
}
