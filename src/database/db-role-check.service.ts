import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * Fail-fast probe for the runtime DataSource role.
 *
 * Multi-tenancy in Shyraq is enforced by PostgreSQL row-level security with
 * `FORCE ROW LEVEL SECURITY` on every tenant-scoped table. PostgreSQL exempts
 * SUPERUSER and BYPASSRLS roles from RLS regardless of FORCE — meaning if the
 * app accidentally connects as `shyraq` (SUPERUSER, the migration role) or
 * any other role with BYPASSRLS, tenant isolation silently breaks with no
 * observable signal at runtime.
 *
 * This service runs once on `onApplicationBootstrap` (after TypeORM has
 * initialized the runtime DataSource) and queries `pg_roles` for the current
 * connecting user. If the role has `rolsuper = true` OR `rolbypassrls = true`,
 * we log a CRITICAL error and abort startup so the misconfig is loud.
 *
 * Escape hatch: `DATABASE_BYPASS_ROLE_CHECK=true` skips the assertion. This
 * is intended for local-dev sessions that intentionally connect with the
 * superuser (e.g. one-off script runs); it should NEVER be set in prod.
 *
 * The migration CLI uses a separate DataSource (`src/database/data-source.ts`)
 * with `DATABASE_MIGRATION_USERNAME` — that path doesn't go through this
 * service, so DDL migrations still run as the bootstrap superuser as expected.
 */
@Injectable()
export class DbRoleCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DbRoleCheckService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.DATABASE_BYPASS_ROLE_CHECK === 'true') {
      this.logger.warn(
        'DATABASE_BYPASS_ROLE_CHECK=true — skipping runtime DB role check. ' +
          'RLS may not apply if the connecting role is SUPERUSER/BYPASSRLS. ' +
          'Do NOT set this in production.',
      );
      return;
    }
    await assertRuntimeRoleNonPrivileged(this.dataSource, this.logger);
  }
}

/**
 * Pure helper exported for unit-testability. Throws if the role would
 * silently bypass RLS, otherwise resolves. The caller decides whether to
 * abort the process — `onApplicationBootstrap` re-throwing causes Nest to
 * fail bootstrap, which is the desired behavior.
 */
export async function assertRuntimeRoleNonPrivileged(
  dataSource: DataSource,
  logger: Pick<Logger, 'error' | 'log'>,
): Promise<void> {
  const rows = (await dataSource.query(
    `SELECT current_user AS rolname, rolsuper, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
  )) as Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>;
  if (rows.length === 0) {
    // Should not happen — current_user must exist in pg_roles. Treat as
    // critical so we don't run with an unknown identity.
    const msg =
      'CRITICAL: pg_roles lookup for current_user returned no rows. ' +
      'Refusing to start — RLS contract cannot be verified.';
    logger.error(msg);
    throw new Error('db_role_check_failed');
  }
  const row = rows[0];
  if (row.rolsuper || row.rolbypassrls) {
    const msg =
      `CRITICAL: runtime DB role "${row.rolname}" has ` +
      `rolsuper=${row.rolsuper}, rolbypassrls=${row.rolbypassrls}. ` +
      'PostgreSQL exempts such roles from row-level security even with ' +
      'FORCE RLS — multi-tenant isolation will NOT apply. Refusing to ' +
      'start. Use a NOSUPERUSER NOBYPASSRLS role (e.g. shyraq_app) for ' +
      'DATABASE_USERNAME, or set DATABASE_BYPASS_ROLE_CHECK=true to ' +
      'override (not for production).';
    logger.error(msg);
    throw new Error('db_role_check_failed');
  }
  logger.log(
    `DB role check ok: "${row.rolname}" (rolsuper=false, rolbypassrls=false). ` +
      'RLS will apply.',
  );
}
