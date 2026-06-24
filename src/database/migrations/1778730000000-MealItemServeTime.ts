import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BR-014 — adds the optional `serve_time` column to `meal_items`.
 *
 * The mobile menu prototype (C-01) shows a serve time per meal. The menu item
 * previously carried no time field, so we add a nullable `"HH:mm"` string.
 *
 * Stored as `text` (round-trips the string verbatim with no timezone surprises
 * that a `time`/`timestamp` type would introduce). Validation of the `HH:mm`
 * shape lives at the DTO boundary (`@Matches`).
 *
 * `meal_items` has no own RLS — tenant isolation is enforced via the FK to
 * `meal_plans` (see B7 `1777593606000:19-21, 230-243`). So this migration is a
 * bare ADD/DROP COLUMN — no RLS / FORCE / GRANT statements needed.
 */
export class MealItemServeTime1778730000000 implements MigrationInterface {
  name = 'MealItemServeTime1778730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "meal_items" ADD COLUMN "serve_time" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "meal_items" DROP COLUMN "serve_time"`,
    );
  }
}
