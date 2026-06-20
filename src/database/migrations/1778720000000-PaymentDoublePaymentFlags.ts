import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Double-payment detection flags on `payments` (#5b).
 *
 * Two DIFFERENT guardians can pay the SAME monthly invoice in parallel (one
 * invoice per child per month → same invoice_id). The single-parent recall
 * guard cannot stop two distinct payers racing, so when the SECOND payment
 * settles we flag it instead of silently over-crediting the account:
 *
 *   - `refund_required`        — surfaced to the admin app ("Нужен возврат").
 *   - `refund_reason`          — e.g. 'double_payment'.
 *   - `duplicate_of_payment_id`— the FIRST (kept) payment, so the frontend can
 *                                link to it ("Двойная оплата, см. оплату <id>").
 *
 * The admin reviews and triggers the refund MANUALLY (no auto-refund — Kaspi has
 * no refund idempotency key). Additive & backward-compatible: existing rows take
 * `refund_required = false`. The partial index keeps the admin "needs refund"
 * query cheap.
 */
export class PaymentDoublePaymentFlags1778720000000
  implements MigrationInterface
{
  name = 'PaymentDoublePaymentFlags1778720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN "refund_required" boolean NOT NULL DEFAULT false,
        ADD COLUMN "refund_reason" text,
        ADD COLUMN "duplicate_of_payment_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "payments_duplicate_of_payment_id_fkey"
        FOREIGN KEY ("duplicate_of_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_payments_refund_required"
        ON "payments" ("kindergarten_id")
        WHERE "refund_required" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_refund_required"`);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT IF EXISTS "payments_duplicate_of_payment_id_fkey"
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "duplicate_of_payment_id",
        DROP COLUMN IF EXISTS "refund_reason",
        DROP COLUMN IF EXISTS "refund_required"
    `);
  }
}
