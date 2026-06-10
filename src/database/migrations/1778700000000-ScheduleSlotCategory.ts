import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schedule slot category — follow-up to B7.
 *
 * Adds an explicit `category` (slot type) to schedule slots so the admin
 * week-grid can colour each slot by type (Урок / Активность / Еда / Сон)
 * instead of guessing from `activity_name` keywords. The same enum is added
 * to `activity_events` so the colour carries end-to-end into the staff/parent
 * day views — the value is copied from the originating slot during the
 * week-copy projection; ad-hoc events fall back to the column default.
 *
 * Backfill: existing rows take the column DEFAULT `'activity'`. We
 * deliberately skip a keyword heuristic — it is locale-specific and prone to
 * mis-categorisation; admins recategorise from the UI where it matters.
 *
 * Additive & backward-compatible: NOT NULL DEFAULT means no null-handling for
 * clients, and clients that don't send `category` keep working.
 */
export class ScheduleSlotCategory1778700000000 implements MigrationInterface {
  name = 'ScheduleSlotCategory1778700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE slot_category AS ENUM (
        'lesson',
        'activity',
        'meal',
        'sleep'
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "schedule_template_slots"
        ADD COLUMN "category" slot_category NOT NULL DEFAULT 'activity'
    `);

    await queryRunner.query(`
      ALTER TABLE "activity_events"
        ADD COLUMN "category" slot_category NOT NULL DEFAULT 'activity'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "activity_events" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "schedule_template_slots" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS slot_category`);
  }
}
