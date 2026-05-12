import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B21 T1 — Lifecycle index.
 *
 * Pre-work finding: `archived_at` and `archive_reason` columns were already
 * added to the `children` table by the P5 migration
 * (ChildrenAndGuardians1777593604000). No column changes are needed here.
 *
 * This migration adds only the composite index
 * `idx_children_status_archived_at (kindergarten_id, status, archived_at)`
 * which enables efficient filtering in MonthlyBillingProcessor (skip archived
 * rows) and the pro-rata processor (archived_at boundary lookup).
 */
export class B21Lifecycle1778546628246 implements MigrationInterface {
  name = 'B21Lifecycle1778546628246';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotent — CREATE INDEX IF NOT EXISTS is safe to re-run.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_children_status_archived_at"
        ON "children" ("kindergarten_id", "status", "archived_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_children_status_archived_at"`,
    );
  }
}
