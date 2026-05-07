import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B16 Custom Discounts FK fix — `created_by` correction.
 *
 * The original B16 migration declared:
 *   `custom_discounts.created_by  REFERENCES staff_members(id)`
 *
 * The controller (`AdminCustomDiscountController.create`) populates
 * `created_by` from `req.user.sub`, which is a `users.id` (not a
 * `staff_members.id`). The mismatched FK causes a FK violation at runtime
 * whenever an admin creates a custom discount — identical root-cause to
 * the B13 `tariff_assignments.assigned_by` / `refunds.processed_by` bug
 * that was fixed in B13BillingFkFix.
 *
 * Fix: drop the FK constraint and re-add it pointing at `users(id)`.
 */
export class B16CustomDiscountsFkFix1777890001000 implements MigrationInterface {
  name = 'B16CustomDiscountsFkFix1777890001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "custom_discounts"
         DROP CONSTRAINT IF EXISTS "custom_discounts_created_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "custom_discounts"
         ADD CONSTRAINT "custom_discounts_created_by_fkey"
         FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore original (broken) constraint so the migration is reversible.
    await queryRunner.query(
      `ALTER TABLE "custom_discounts"
         DROP CONSTRAINT IF EXISTS "custom_discounts_created_by_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "custom_discounts"
         ADD CONSTRAINT "custom_discounts_created_by_fkey"
         FOREIGN KEY ("created_by") REFERENCES "staff_members"("id")`,
    );
  }
}
