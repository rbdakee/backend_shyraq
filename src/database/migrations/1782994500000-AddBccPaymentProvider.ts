import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reserve the stable `bcc` provider key before the acquiring adapter lands.
 * The column remains text; only its CHECK constraint changes.
 */
export class AddBccPaymentProvider1782994500000 implements MigrationInterface {
  name = 'AddBccPaymentProvider1782994500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT "chk_payments_provider",
        ADD CONSTRAINT "chk_payments_provider"
          CHECK ("provider" IN (
            'mock',
            'halyk_epay',
            'kaspi_pay',
            'tiptoppay',
            'freedom_pay',
            'bcc',
            'cash'
          ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT "chk_payments_provider",
        ADD CONSTRAINT "chk_payments_provider"
          CHECK ("provider" IN (
            'mock',
            'halyk_epay',
            'kaspi_pay',
            'tiptoppay',
            'freedom_pay',
            'cash'
          ))
    `);
  }
}
