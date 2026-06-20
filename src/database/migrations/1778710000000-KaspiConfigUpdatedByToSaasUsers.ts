import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fix `PUT /saas/kaspi/config` → 500.
 *
 * `kaspi_global_config.updated_by` was created with a FK to `users(id)`, but the
 * ONLY caller of the update endpoint is a SUPER-ADMIN, whose identity lives in
 * `saas_users`, not `users`. Writing `updated_by = <saas_user.id>` therefore
 * always violated `kaspi_global_config_updated_by_fkey` and the documented way
 * for a super-admin to bump the Kaspi app build was unusable (every PUT 500'd).
 *
 * Repoint the FK to `saas_users(id)` (ON DELETE SET NULL — the audit pointer is
 * non-critical). Existing rows carry `updated_by = NULL`, so the repoint is safe
 * with no backfill.
 */
export class KaspiConfigUpdatedByToSaasUsers1778710000000 implements MigrationInterface {
  name = 'KaspiConfigUpdatedByToSaasUsers1778710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kaspi_global_config"
        DROP CONSTRAINT IF EXISTS "kaspi_global_config_updated_by_fkey"
    `);
    await queryRunner.query(`
      ALTER TABLE "kaspi_global_config"
        ADD CONSTRAINT "kaspi_global_config_updated_by_fkey"
        FOREIGN KEY ("updated_by") REFERENCES "saas_users"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "kaspi_global_config"
        DROP CONSTRAINT IF EXISTS "kaspi_global_config_updated_by_fkey"
    `);
    await queryRunner.query(`
      ALTER TABLE "kaspi_global_config"
        ADD CONSTRAINT "kaspi_global_config_updated_by_fkey"
        FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL
    `);
  }
}
