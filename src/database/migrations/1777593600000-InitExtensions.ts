import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bootstraps the database with required extensions and creates a dedicated
 * non-superuser application role (`shyraq_app`).
 *
 * RLS policies are bypassed by SUPERUSER and BYPASSRLS roles regardless of
 * `FORCE ROW LEVEL SECURITY`, so the application MUST connect using
 * `shyraq_app` (or another NOSUPERUSER NOBYPASSRLS role) for tenant
 * isolation to actually take effect. Migrations themselves still run as the
 * bootstrap superuser (DDL owner) so they can manage schema and policies.
 */
export class InitExtensions1777593600000 implements MigrationInterface {
  name = 'InitExtensions1777593600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Create the application role if it does not already exist.
    // Idempotent — safe to re-run on existing databases.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shyraq_app') THEN
          CREATE ROLE shyraq_app
            WITH LOGIN PASSWORD 'shyraq_app'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END
      $$;
    `);

    // Hard assertion: shyraq_app MUST be NOSUPERUSER NOBYPASSRLS for RLS
    // to actually enforce tenant isolation. If a previous misconfigured
    // bootstrap (e.g. docker-compose seeding shyraq_app as POSTGRES_USER)
    // left it as superuser, this fails loudly instead of silently leaking
    // cross-tenant data. Recovery: drop the volume and re-bootstrap with
    // the migration superuser (shyraq) as POSTGRES_USER.
    await queryRunner.query(`
      DO $$
      DECLARE
        is_super  boolean;
        is_bypass boolean;
      BEGIN
        SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
          FROM pg_roles WHERE rolname = 'shyraq_app';
        IF is_super OR is_bypass THEN
          RAISE EXCEPTION
            'shyraq_app has rolsuper=% rolbypassrls=% — both must be false. '
            'Runtime role would bypass RLS even with FORCE ROW LEVEL SECURITY, '
            'silently breaking tenant isolation. Recover by dropping the PG '
            'volume and re-bootstrapping with POSTGRES_USER=shyraq (the '
            'migration superuser), so InitExtensions creates shyraq_app fresh '
            'with the correct NOSUPERUSER NOBYPASSRLS attributes.',
            is_super, is_bypass;
        END IF;
      END
      $$;
    `);

    // Grant the app role enough to run regular CRUD across the public schema.
    // Tables added by future migrations also need access — handled via the
    // ALTER DEFAULT PRIVILEGES below, scoped to whatever role runs the
    // migration (the table owner).
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO shyraq_app`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO shyraq_app`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shyraq_app`,
    );
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO shyraq_app
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO shyraq_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse the grants then drop the role. Default-privileges revoke must
    // come first because Postgres refuses to drop a role that owns ACLs.
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM shyraq_app
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE USAGE, SELECT ON SEQUENCES FROM shyraq_app
    `);
    await queryRunner.query(
      `REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM shyraq_app`,
    );
    await queryRunner.query(
      `REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public FROM shyraq_app`,
    );
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM shyraq_app`);
    await queryRunner.query(`DROP ROLE IF EXISTS shyraq_app`);

    await queryRunner.query(`DROP EXTENSION IF EXISTS "uuid-ossp"`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS "pgcrypto"`);
  }
}
