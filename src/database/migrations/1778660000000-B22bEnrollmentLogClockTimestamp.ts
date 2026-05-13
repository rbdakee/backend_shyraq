import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22b CI hotfix — `enrollment_status_log.created_at` default switched from
 * `now()` to `clock_timestamp()`.
 *
 * `now()` is an alias for `transaction_timestamp()`: it returns the same
 * value for every statement within one transaction. EnrollmentService
 * sometimes writes two log rows in a single ambient TX (e.g.
 * `new → in_processing → card_created` flow). Both rows land with identical
 * `created_at`, and the table's `id` is `gen_random_uuid()` so it can't
 * disambiguate either — readers ordering by `(created_at, id)` see rows in
 * non-deterministic order. CI surfaced this as a flake in
 * `enrollment.service.integration.spec.ts:412`.
 *
 * `clock_timestamp()` returns wall-clock time at the moment the function is
 * evaluated, advancing within a single statement and across statements in
 * the same TX. Two `INSERT` round-trips from TypeORM are separate statements,
 * so they always pick up different timestamps — readers ordering by
 * `created_at ASC` get insertion order.
 */
export class B22bEnrollmentLogClockTimestamp1778660000000 implements MigrationInterface {
  name = 'B22bEnrollmentLogClockTimestamp1778660000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "enrollment_status_log"
        ALTER COLUMN "created_at" SET DEFAULT clock_timestamp()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "enrollment_status_log"
        ALTER COLUMN "created_at" SET DEFAULT now()
    `);
  }
}
