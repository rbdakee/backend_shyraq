import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B7 — Schedule & Meal Tables.
 *
 * Tables (creation order respects FK deps):
 *   1. activity_event_status  (ENUM)
 *   2. schedule_templates     (tenant-scoped; group_id nullable = kg-wide template)
 *   3. schedule_template_slots (child of schedule_templates; no kindergarten_id col)
 *   4. activity_events        (tenant-scoped; timestamptz starts_at/ends_at)
 *   5. meal_plans             (tenant-scoped; date col; partial-unique indexes)
 *   6. meal_items             (child of meal_plans; no kindergarten_id col)
 *   7. schedule_week_snapshots (tenant-scoped; unique per kg+group+week)
 *
 * RLS pattern identical to EnrollmentTables (B5):
 *   ENABLE + FORCE ROW LEVEL SECURITY, policy `tenant_isolation`
 *   USING + WITH CHECK via coalesce(bypass_rls) OR kindergarten_id = setting::uuid.
 *
 * For tables without kindergarten_id (schedule_template_slots, meal_items),
 * RLS is applied through the parent FK join — no direct RLS on those tables.
 * They are still owned by shyraq and accessible via DEFAULT PRIVILEGES.
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions — no
 * per-table GRANT needed for new tables created by the migration owner role.
 */
export class B7ScheduleAndMeal1777593606000 implements MigrationInterface {
  name = 'B7ScheduleAndMeal1777593606000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. activity_event_status ENUM ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE activity_event_status AS ENUM (
        'scheduled',
        'in_progress',
        'completed',
        'cancelled'
      )
    `);

    // ── 2. schedule_templates ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "schedule_templates" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "group_id"        uuid                 REFERENCES "groups"("id") ON DELETE CASCADE,
        "name"            varchar(100) NOT NULL,
        "recurrence"      varchar(20)  NOT NULL DEFAULT 'weekly',
        "is_active"       boolean     NOT NULL DEFAULT true,
        "valid_from"      date        NOT NULL,
        "valid_until"     date,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_schedule_templates_kg_group_active"
        ON "schedule_templates" ("kindergarten_id", "group_id", "is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_schedule_templates_kg"
        ON "schedule_templates" ("kindergarten_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "schedule_templates" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedule_templates" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "schedule_templates"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. schedule_template_slots ───────────────────────────────────────────
    // No kindergarten_id column — isolation via parent schedule_templates FK.
    await queryRunner.query(`
      CREATE TABLE "schedule_template_slots" (
        "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "template_id"   uuid        NOT NULL REFERENCES "schedule_templates"("id") ON DELETE CASCADE,
        "day_of_week"   varchar(3)  NOT NULL,
        "start_time"    time        NOT NULL,
        "end_time"      time        NOT NULL,
        "activity_name" varchar(120) NOT NULL,
        "location_id"   uuid                 REFERENCES "locations"("id") ON DELETE SET NULL,
        "description"   text
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_schedule_template_slots_unique"
        ON "schedule_template_slots" ("template_id", "day_of_week", "start_time")
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_schedule_template_slots_template"
        ON "schedule_template_slots" ("template_id")`,
    );

    // ── 4. activity_events ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "activity_events" (
        "id"               uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid                  NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "group_id"         uuid                  NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
        "template_slot_id" uuid                           REFERENCES "schedule_template_slots"("id") ON DELETE SET NULL,
        "activity_name"    varchar(120)          NOT NULL,
        "location_id"      uuid                           REFERENCES "locations"("id") ON DELETE SET NULL,
        "starts_at"        timestamptz           NOT NULL,
        "ends_at"          timestamptz,
        "status"           activity_event_status NOT NULL DEFAULT 'scheduled',
        "created_by"       uuid                           REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "notes"            text,
        "created_at"       timestamptz           NOT NULL DEFAULT now(),
        "updated_at"       timestamptz           NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_activity_events_kg_group_starts"
        ON "activity_events" ("kindergarten_id", "group_id", "starts_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_activity_events_group_starts"
        ON "activity_events" ("group_id", "starts_at")`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_activity_events_template_slot"
        ON "activity_events" ("template_slot_id")
        WHERE "template_slot_id" IS NOT NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_activity_events_kg"
        ON "activity_events" ("kindergarten_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "activity_events" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "activity_events" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "activity_events"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 5. meal_plans ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "meal_plans" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "date"            date        NOT NULL,
        "group_id"        uuid                 REFERENCES "groups"("id") ON DELETE CASCADE,
        "is_published"    boolean     NOT NULL DEFAULT true,
        "notes"           jsonb,
        "source"          varchar(40) NOT NULL DEFAULT 'manual',
        "copied_from"     uuid                 REFERENCES "meal_plans"("id") ON DELETE SET NULL,
        "created_by"      uuid                 REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Partial-unique indexes for NULL-safe uniqueness (PG NULL != NULL semantics).
    // One meal_plan per date per group (when group_id IS NOT NULL).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_meal_plans_unique_group"
        ON "meal_plans" ("kindergarten_id", "group_id", "date")
        WHERE "group_id" IS NOT NULL
    `);
    // One kindergarten-wide meal_plan per date (when group_id IS NULL).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_meal_plans_unique_kg"
        ON "meal_plans" ("kindergarten_id", "date")
        WHERE "group_id" IS NULL
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_meal_plans_kg_date"
        ON "meal_plans" ("kindergarten_id", "date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_meal_plans_group_date"
        ON "meal_plans" ("group_id", "date")`,
    );

    await queryRunner.query(
      `ALTER TABLE "meal_plans" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "meal_plans" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "meal_plans"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 6. meal_type ENUM + meal_items ───────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE meal_type AS ENUM (
        'breakfast',
        'snack_am',
        'lunch',
        'snack_pm',
        'dinner'
      )
    `);

    // No kindergarten_id column — isolation via parent meal_plans FK.
    await queryRunner.query(`
      CREATE TABLE "meal_items" (
        "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "meal_plan_id" uuid        NOT NULL REFERENCES "meal_plans"("id") ON DELETE CASCADE,
        "meal_type"    meal_type   NOT NULL,
        "dish_name"    jsonb       NOT NULL,
        "description"  jsonb,
        "allergens"    text[],
        "photo_url"    text,
        "calories"     int,
        "position"     int         NOT NULL DEFAULT 0
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_meal_items_meal_plan"
        ON "meal_items" ("meal_plan_id")`,
    );

    // ── 7. schedule_week_snapshots ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "schedule_week_snapshots" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "group_id"        uuid        NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
        "week_start_date" date        NOT NULL,
        "source"          varchar(40) NOT NULL,
        "copied_from"     uuid                 REFERENCES "schedule_week_snapshots"("id") ON DELETE SET NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_schedule_week_snapshots_unique"
        ON "schedule_week_snapshots" ("group_id", "week_start_date")
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_schedule_week_snapshots_kg"
        ON "schedule_week_snapshots" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_schedule_week_snapshots_group"
        ON "schedule_week_snapshots" ("group_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "schedule_week_snapshots" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedule_week_snapshots" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "schedule_week_snapshots"
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
    // Reverse order: snapshots → meal_items → meal_plans → activity_events
    //              → schedule_template_slots → schedule_templates → ENUM

    // 7. schedule_week_snapshots
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "schedule_week_snapshots"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "schedule_week_snapshots" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "schedule_week_snapshots" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_schedule_week_snapshots_group"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_schedule_week_snapshots_kg"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_schedule_week_snapshots_unique"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_week_snapshots"`);

    // 6. meal_items + meal_type ENUM
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_meal_items_meal_plan"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "meal_items"`);
    await queryRunner.query(`DROP TYPE IF EXISTS meal_type`);

    // 5. meal_plans
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "meal_plans"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "meal_plans" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "meal_plans" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_meal_plans_group_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_meal_plans_kg_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_meal_plans_unique_kg"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_meal_plans_unique_group"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "meal_plans"`);

    // 4. activity_events
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "activity_events"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "activity_events" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "activity_events" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_activity_events_kg"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_activity_events_template_slot"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_activity_events_group_starts"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_activity_events_kg_group_starts"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "activity_events"`);

    // 3. schedule_template_slots
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_schedule_template_slots_template"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_schedule_template_slots_unique"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_template_slots"`);

    // 2. schedule_templates
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "schedule_templates"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "schedule_templates" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "schedule_templates" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_schedule_templates_kg"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_schedule_templates_kg_group_active"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_templates"`);

    // 1. activity_event_status ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS activity_event_status`);
  }
}
