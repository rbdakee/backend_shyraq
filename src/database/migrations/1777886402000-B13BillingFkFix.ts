import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B13 Billing FK fix — `assigned_by` and `processed_by` correction.
 *
 * The original B13 migration declared:
 *   `tariff_assignments.assigned_by  REFERENCES staff_members(id)`
 *   `refunds.processed_by            REFERENCES staff_members(id)`
 *
 * Both controllers (AdminTariffAssignmentController, AdminRefundController)
 * populate those columns from `req.user.sub`, which is a `users.id` (not a
 * `staff_members.id`). The mismatched FK caused a FK violation at runtime
 * whenever an admin created an assignment or approved a refund.
 *
 * Fix: drop the FK constraints and re-add them pointing at `users(id)`.
 * The column values already stored are user UUIDs so no data migration is
 * needed (the constraint simply could not be satisfied before this fix).
 */
export class B13BillingFkFix1777886402000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── tariff_assignments.assigned_by ────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "tariff_assignments"
         DROP CONSTRAINT IF EXISTS "tariff_assignments_assigned_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tariff_assignments"
         ADD CONSTRAINT "tariff_assignments_assigned_by_fkey"
         FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT`,
    );

    // ── refunds.processed_by ──────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "refunds"
         DROP CONSTRAINT IF EXISTS "refunds_processed_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds"
         ADD CONSTRAINT "refunds_processed_by_fkey"
         FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore original (broken) constraints so the migration is reversible.
    await queryRunner.query(
      `ALTER TABLE "tariff_assignments"
         DROP CONSTRAINT IF EXISTS "tariff_assignments_assigned_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tariff_assignments"
         ADD CONSTRAINT "tariff_assignments_assigned_by_fkey"
         FOREIGN KEY ("assigned_by") REFERENCES "staff_members"("id") ON DELETE RESTRICT`,
    );

    await queryRunner.query(
      `ALTER TABLE "refunds"
         DROP CONSTRAINT IF EXISTS "refunds_processed_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refunds"
         ADD CONSTRAINT "refunds_processed_by_fkey"
         FOREIGN KEY ("processed_by") REFERENCES "staff_members"("id") ON DELETE SET NULL`,
    );
  }
}
