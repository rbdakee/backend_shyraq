import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CCTV display policy, second shape: common cameras + hide rules.
 *
 * The first shape split the day into working / non-working hours, each with a
 * mode (follow the schedule, a fixed camera list, or nothing). Kindergartens do
 * not run group schedules; what they want is simpler:
 *  - the child's group camera is always shown (group → its assigned location);
 *  - a list of common cameras everyone sees (canteen, clubs);
 *  - time rules hiding some or all of those common cameras on chosen weekdays
 *    (lunch break, night). A rule may run past midnight.
 *
 * The old columns are dropped rather than translated: there is no faithful
 * mapping from "work hours: show entrance cameras" onto the new model, and the
 * policy only ever ran on dev. Existing rows get the defaults the service
 * returns for a kindergarten with no row — no common cameras and a night rule
 * prepared but switched off.
 */
export class CctvDisplayRules1790850478000 implements MigrationInterface {
  name = 'CctvDisplayRules1790850478000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "cctv_display_policies"
        DROP CONSTRAINT IF EXISTS "chk_cctv_display_policies_work_hours_mode",
        DROP CONSTRAINT IF EXISTS "chk_cctv_display_policies_off_hours_mode",
        DROP CONSTRAINT IF EXISTS "chk_cctv_display_policies_window",
        DROP CONSTRAINT IF EXISTS "chk_cctv_display_policies_work_days",
        DROP COLUMN "work_days",
        DROP COLUMN "opens_at",
        DROP COLUMN "closes_at",
        DROP COLUMN "work_hours_mode",
        DROP COLUMN "work_hours_camera_ids",
        DROP COLUMN "off_hours_mode",
        DROP COLUMN "off_hours_camera_ids",
        ADD COLUMN "common_camera_ids" uuid[] NOT NULL DEFAULT '{}',
        ADD COLUMN "hide_rules" jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD CONSTRAINT "chk_cctv_display_policies_hide_rules_array"
          CHECK (jsonb_typeof("hide_rules") = 'array')
    `);

    await queryRunner.query(`
      UPDATE "cctv_display_policies"
         SET "hide_rules" = '[{"name":"Ночь","enabled":false,"days":[1,2,3,4,5,6,7],"from":"19:00","to":"08:00","all_cameras":true,"camera_ids":[]}]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "cctv_display_policies"
        DROP CONSTRAINT IF EXISTS "chk_cctv_display_policies_hide_rules_array",
        DROP COLUMN "common_camera_ids",
        DROP COLUMN "hide_rules",
        ADD COLUMN "work_days" smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
        ADD COLUMN "opens_at" time NOT NULL DEFAULT '07:00',
        ADD COLUMN "closes_at" time NOT NULL DEFAULT '19:00',
        ADD COLUMN "work_hours_mode" varchar(16) NOT NULL DEFAULT 'schedule',
        ADD COLUMN "work_hours_camera_ids" uuid[] NOT NULL DEFAULT '{}',
        ADD COLUMN "off_hours_mode" varchar(16) NOT NULL DEFAULT 'schedule',
        ADD COLUMN "off_hours_camera_ids" uuid[] NOT NULL DEFAULT '{}',
        ADD CONSTRAINT "chk_cctv_display_policies_work_hours_mode"
          CHECK ("work_hours_mode" IN ('schedule','cameras','off')),
        ADD CONSTRAINT "chk_cctv_display_policies_off_hours_mode"
          CHECK ("off_hours_mode" IN ('schedule','cameras','off')),
        ADD CONSTRAINT "chk_cctv_display_policies_window"
          CHECK ("opens_at" < "closes_at"),
        ADD CONSTRAINT "chk_cctv_display_policies_work_days"
          CHECK ("work_days" <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
    `);
  }
}
