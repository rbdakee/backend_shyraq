import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gate F persistence for bounded BCC TRTYPE=90 reconciliation.
 *
 * The payment remains processing after the 24-hour automatic window; the
 * manual-review timestamp is an operational marker, not a false bank verdict.
 */
export class AddBccPaymentReconciliation1783348300000 implements MigrationInterface {
  name = 'AddBccPaymentReconciliation1783348300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN "reconciliation_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "last_reconciled_at" timestamptz,
        ADD COLUMN "next_reconciliation_at" timestamptz,
        ADD COLUMN "manual_review_required_at" timestamptz,
        ADD CONSTRAINT "chk_payments_reconciliation_attempts"
          CHECK ("reconciliation_attempts" >= 0)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_payments_provider_status_next_reconciliation"
        ON "payments" ("provider", "status", "next_reconciliation_at")
        WHERE "next_reconciliation_at" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_payments_provider_manual_review"
        ON "payments" ("provider", "manual_review_required_at")
        WHERE "manual_review_required_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payments_provider_manual_review"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payments_provider_status_next_reconciliation"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT IF EXISTS "chk_payments_reconciliation_attempts",
        DROP COLUMN IF EXISTS "manual_review_required_at",
        DROP COLUMN IF EXISTS "next_reconciliation_at",
        DROP COLUMN IF EXISTS "last_reconciled_at",
        DROP COLUMN IF EXISTS "reconciliation_attempts"
    `);
  }
}
