import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop TRUNCATE from the runtime app role (`shyraq_app`).
 *
 * RLS does NOT cover TRUNCATE — it's a DDL-class operation that bypasses
 * row-level policies entirely. The original `InitExtensions` migration granted
 * TRUNCATE alongside the regular CRUD verbs, which means a misconfig or SQL
 * injection at runtime could wipe every tenant's data even with FORCE RLS in
 * place.
 *
 * We do not edit `1777593600000-InitExtensions.ts` because it is already
 * applied in prod — rewriting it would diverge prod state from migration code.
 * This new migration is the canonical pattern: revoke at the privilege level
 * AND for default privileges, so future tables added by later migrations are
 * also created without TRUNCATE for `shyraq_app`.
 *
 * Tests that rely on TRUNCATE (`test/helpers/app.ts::truncateAll`) connect via
 * the migration role (`shyraq` SUPERUSER) — they are unaffected.
 */
export class RevokeTruncateFromAppRole1777800000000 implements MigrationInterface {
  name = 'RevokeTruncateFromAppRole1777800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing tables: drop TRUNCATE without disturbing the SELECT/INSERT/
    // UPDATE/DELETE grants the app needs at runtime.
    await queryRunner.query(
      `REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM shyraq_app`,
    );
    // Tables created by future migrations: keep TRUNCATE off the default
    // privilege set so the next `CREATE TABLE` does not silently re-grant it.
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE TRUNCATE ON TABLES FROM shyraq_app
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reversible — restore the (insecure) original grant. Useful only when
    // rolling back to a prod state that pre-dates this fix.
    await queryRunner.query(
      `GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO shyraq_app`,
    );
    await queryRunner.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT TRUNCATE ON TABLES TO shyraq_app
    `);
  }
}
