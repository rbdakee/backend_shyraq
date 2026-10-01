import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-kindergarten CCTV display policy — what a parent sees in the app and
 * when, instead of that answer being hardwired in the service.
 *
 * Until now the parent list was always "wherever the child's group is right
 * now": schedule event → `groups.current_location_id` → cameras there. That is
 * still the default (`work_hours_mode = 'schedule'`, `off_hours_mode =
 * 'schedule'`, both camera lists empty), so a kindergarten that never opens
 * the new screen keeps exactly today's behaviour and no row has to exist for
 * it — the service falls back to these same defaults when the table is empty.
 *
 * What the row adds is an admin-editable override on two axes:
 *  - a working-hours window (`work_days` + `opens_at`/`closes_at`, kindergarten
 *    local time) splitting the day into two slots;
 *  - per slot, a mode and a camera list: follow the schedule (`schedule`, with
 *    the list acting as the fallback when the schedule points nowhere), show a
 *    fixed set of cameras to everyone (`cameras`), or show nothing (`off`).
 *
 * `*_camera_ids` are uuid[] rather than a child table on purpose: the policy is
 * read on every parent CCTV request and this keeps that hot path a single-row
 * lookup. There is no FK — cameras are soft-archived, never deleted, and the
 * read path already drops anything not streamable, so a stale id degrades to
 * "not shown" instead of a dangling reference. The write path validates that
 * every id belongs to the caller's kindergarten.
 */
export class CctvDisplayPolicy1789962748848 implements MigrationInterface {
  name = 'CctvDisplayPolicy1789962748848';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cctv_display_policies" (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"       uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "work_days"             smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
        "opens_at"              time NOT NULL DEFAULT '07:00',
        "closes_at"             time NOT NULL DEFAULT '19:00',
        "work_hours_mode"       varchar(16) NOT NULL DEFAULT 'schedule',
        "work_hours_camera_ids" uuid[] NOT NULL DEFAULT '{}',
        "off_hours_mode"        varchar(16) NOT NULL DEFAULT 'schedule',
        "off_hours_camera_ids"  uuid[] NOT NULL DEFAULT '{}',
        "created_at"            timestamptz NOT NULL DEFAULT now(),
        "updated_at"            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_cctv_display_policies_work_hours_mode"
          CHECK ("work_hours_mode" IN ('schedule','cameras','off')),
        CONSTRAINT "chk_cctv_display_policies_off_hours_mode"
          CHECK ("off_hours_mode" IN ('schedule','cameras','off')),
        CONSTRAINT "chk_cctv_display_policies_window"
          CHECK ("opens_at" < "closes_at"),
        CONSTRAINT "chk_cctv_display_policies_work_days"
          CHECK ("work_days" <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
      )
    `);

    // One policy per kindergarten — the row IS the tenant's setting, so the
    // uniqueness is what lets the service upsert on kindergarten_id alone.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_cctv_display_policies_kg"
        ON "cctv_display_policies" ("kindergarten_id")
    `);

    await queryRunner.query(
      `ALTER TABLE "cctv_display_policies" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "cctv_display_policies" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "cctv_display_policies"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "cctv_display_policies"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "cctv_display_policies" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "cctv_display_policies" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_cctv_display_policies_kg"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "cctv_display_policies"`);
  }
}
