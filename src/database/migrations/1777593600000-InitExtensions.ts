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

    // Grant the app role enough to run regular CRUD across the public schema.
    // Tables added by future migrations also need access — handled via the
    // ALTER DEFAULT PRIVILEGES below, scoped to whatever role runs the
    // migration (the table owner).
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO shyraq_app`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shyraq_app`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shyraq_app`,
    );
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shyraq_app
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
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM shyraq_app
    `);
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE USAGE, SELECT ON SEQUENCES FROM shyraq_app
    `);
    await queryRunner.query(
      `REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM shyraq_app`,
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
