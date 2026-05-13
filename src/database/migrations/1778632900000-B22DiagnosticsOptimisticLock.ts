import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22a T4 — Optimistic-lock `row_version` column on the three diagnostics
 * tables.
 *
 * Closes SM3 + B18 T6-M4 (race protection on PATCH paths). The existing
 * `diagnostic_templates.version` column is the **schema version** (semantic,
 * exposed to clients via DTO + bumped only when the JSONB schema deeply
 * differs). We need a separate, invisible `row_version` so concurrent
 * PATCHes on name/description/is_active are also serialised — and so
 * `diagnostic_entries` / `progress_notes` (no schema-version) get the same
 * defence.
 *
 * Each repository's `update()` method now issues a conditional UPDATE:
 *
 *   UPDATE <table>
 *      SET ..., row_version = row_version + 1
 *    WHERE id = $1 AND kindergarten_id = $2 AND row_version = $expected
 *    RETURNING row_version
 *
 * If `affected === 0` → throw `OptimisticLockError` (HTTP 409). The
 * service.update() captures `loaded.rowVersion` BEFORE applying the
 * domain mutation and passes it through to the repo.
 *
 * The new column is NOT exposed via DTO — it is internal optimistic-lock
 * state. The `version` column (template only) keeps its existing semantic
 * meaning + DTO field.
 */
export class B22DiagnosticsOptimisticLock1778632900000 implements MigrationInterface {
  name = 'B22DiagnosticsOptimisticLock1778632900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `IF NOT EXISTS` keeps the migration idempotent under accidental
    // re-runs (some dev environments re-create the migration row by
    // hand — these ALTERs would otherwise fail with `column already
    // exists`). DEFAULT 1 backfills every existing row to row_version=1
    // atomically (PG fast-path for fixed defaults — no table rewrite).
    await queryRunner.query(`
      ALTER TABLE "diagnostic_templates"
        ADD COLUMN IF NOT EXISTS "row_version" int NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "diagnostic_entries"
        ADD COLUMN IF NOT EXISTS "row_version" int NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "progress_notes"
        ADD COLUMN IF NOT EXISTS "row_version" int NOT NULL DEFAULT 1
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "progress_notes" DROP COLUMN IF EXISTS "row_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "diagnostic_entries" DROP COLUMN IF EXISTS "row_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "diagnostic_templates" DROP COLUMN IF EXISTS "row_version"`,
    );
  }
}
