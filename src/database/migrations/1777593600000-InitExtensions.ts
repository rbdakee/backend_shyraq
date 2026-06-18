import { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleIdent, appRoleName } from '../app-role.util';

/**
 * Bootstraps the database with required extensions and creates the dedicated
 * non-superuser application role.
 *
 * The role NAME and PASSWORD come from `DATABASE_USERNAME` / `DATABASE_PASSWORD`
 * (the same credentials the runtime connection uses) — NOT hardcoded — so the
 * deployment controls them and production gets a real password instead of a
 * value committed to the repo.
 *
 * RLS policies are bypassed by SUPERUSER and BYPASSRLS roles regardless of
 * `FORCE ROW LEVEL SECURITY`, so the application MUST connect using this
 * NOSUPERUSER NOBYPASSRLS role for tenant isolation to actually take effect.
 * Migrations themselves still run as the bootstrap superuser (DDL owner) so
 * they can manage schema and policies.
 */
export class InitExtensions1777593600000 implements MigrationInterface {
  name = 'InitExtensions1777593600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const roleName = appRoleName();
    const role = appRoleIdent();

    const password = process.env.DATABASE_PASSWORD ?? '';
    if (password.length === 0) {
      throw new Error(
        'InitExtensions: DATABASE_PASSWORD must be set — it becomes the runtime ' +
          'role password.',
      );
    }
    // String-literal escape: double any single quotes.
    const passwordLiteral = `'${password.replace(/'/g, "''")}'`;

    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Create the application role if it does not already exist (idempotent).
    const existing: unknown[] = await queryRunner.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [roleName],
    );
    if (existing.length === 0) {
      await queryRunner.query(
        `CREATE ROLE ${role} WITH LOGIN PASSWORD ${passwordLiteral} ` +
          `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    }

    // Hard assertion: the runtime role MUST be NOSUPERUSER NOBYPASSRLS for RLS
    // to actually enforce tenant isolation. If a previous misconfigured
    // bootstrap (e.g. docker-compose seeding this role as POSTGRES_USER) left
    // it as superuser, fail loudly instead of silently leaking cross-tenant
    // data. Recovery: drop the PG volume and re-bootstrap with the migration
    // superuser as POSTGRES_USER so this migration recreates the role fresh.
    const attrs: Array<{ rolsuper: boolean; rolbypassrls: boolean }> =
      await queryRunner.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
        [roleName],
      );
    if (attrs.length > 0 && (attrs[0].rolsuper || attrs[0].rolbypassrls)) {
      throw new Error(
        `Runtime role "${roleName}" has rolsuper=${attrs[0].rolsuper} ` +
          `rolbypassrls=${attrs[0].rolbypassrls} — both must be false. The role ` +
          'would bypass RLS even with FORCE ROW LEVEL SECURITY, silently breaking ' +
          'tenant isolation. Recover by dropping the PG volume and re-bootstrapping ' +
          'with the migration superuser as POSTGRES_USER.',
      );
    }

    // Grant the app role enough to run regular CRUD across the public schema.
    // Tables added by future migrations are covered by the ALTER DEFAULT
    // PRIVILEGES below, scoped to whatever role runs the migration (the owner).
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    );
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ${role}
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO ${role}
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const role = appRoleIdent();

    // Reverse the grants then drop the role. Default-privileges revoke must
    // come first because Postgres refuses to drop a role that owns ACLs.
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM ${role}
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE USAGE, SELECT ON SEQUENCES FROM ${role}
    `);
    await queryRunner.query(
      `REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${role}`,
    );
    await queryRunner.query(
      `REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
    );
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`);
    await queryRunner.query(`DROP ROLE IF EXISTS ${role}`);

    await queryRunner.query(`DROP EXTENSION IF EXISTS "uuid-ossp"`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS "pgcrypto"`);
  }
}
