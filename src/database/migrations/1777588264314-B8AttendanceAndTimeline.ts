import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B8 — Attendance & Timeline Tables.
 *
 * Tables (creation order respects FK deps):
 *   1. attendance_event_type   (ENUM)
 *   2. attendance_method       (ENUM)
 *   3. child_intraday_status   (ENUM)
 *   4. timeline_entry_type     (ENUM)
 *   5. attendance_events       (tenant-scoped; append-only check-in/out log)
 *   6. child_daily_status      (tenant-scoped; upsert-on-(child_id,date); unique index)
 *   7. timeline_entries        (tenant-scoped; append-friendly journal entries)
 *
 * RLS pattern identical to B7 (ScheduleAndMeal):
 *   ENABLE + FORCE ROW LEVEL SECURITY, policy `tenant_isolation`
 *   USING + WITH CHECK via coalesce(bypass_rls) OR kindergarten_id = setting::uuid.
 *
 * pickup_request_id on attendance_events is intentionally nullable with no FK
 * in B8 — B11 will ALTER TABLE to add REFERENCES pickup_requests(id).
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions — no
 * per-table GRANT needed for new tables created by the migration owner role.
 */
export class B8AttendanceAndTimeline1777588264314 implements MigrationInterface {
  name = 'B8AttendanceAndTimeline1777588264314';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. attendance_event_type ENUM ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE attendance_event_type AS ENUM (
        'check_in',
        'check_out'
      )
    `);

    // ── 2. attendance_method ENUM ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE attendance_method AS ENUM (
        'face_id',
        'manual',
        'otp_pickup'
      )
    `);

    // ── 3. child_intraday_status ENUM ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE child_intraday_status AS ENUM (
        'present',
        'absent',
        'sick',
        'late',
        'early_pickup',
        'on_vacation'
      )
    `);

    // ── 4. timeline_entry_type ENUM ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE timeline_entry_type AS ENUM (
        'check_in',
        'check_out',
        'activity',
        'meal',
        'nap',
        'note',
        'photo',
        'mood',
        'medication'
      )
    `);

    // ── 5. attendance_events ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "attendance_events" (
        "id"                 uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"    uuid                  NOT NULL REFERENCES "kindergartens"("id"),
        "child_id"           uuid                  NOT NULL REFERENCES "children"("id"),
        "event_type"         attendance_event_type NOT NULL,
        "method"             attendance_method     NOT NULL,
        "recorded_by"        uuid                           REFERENCES "staff_members"("id"),
        "pickup_user_id"     uuid                           REFERENCES "users"("id"),
        "pickup_request_id"  uuid,
        "notes"              text,
        "recorded_at"        timestamptz           NOT NULL DEFAULT now(),
        "created_at"         timestamptz           NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_attendance_kg_recorded"
        ON "attendance_events" ("kindergarten_id", "recorded_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_attendance_child_recorded"
        ON "attendance_events" ("child_id", "recorded_at" DESC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "attendance_events" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "attendance_events" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "attendance_events"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 6. child_daily_status ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "child_daily_status" (
        "id"              uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid                  NOT NULL REFERENCES "kindergartens"("id"),
        "child_id"        uuid                  NOT NULL REFERENCES "children"("id"),
        "date"            date                  NOT NULL,
        "status"          child_intraday_status NOT NULL DEFAULT 'absent',
        "note"            text,
        "set_by"          uuid                           REFERENCES "staff_members"("id"),
        "updated_at"      timestamptz           NOT NULL DEFAULT now()
      )
    `);

    // Unique per (child_id, date) — one status row per child per day.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_daily_status_child_date"
        ON "child_daily_status" ("child_id", "date")
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_daily_status_kg_date"
        ON "child_daily_status" ("kindergarten_id", "date")`,
    );

    await queryRunner.query(
      `ALTER TABLE "child_daily_status" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "child_daily_status" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "child_daily_status"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 7. timeline_entries ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "timeline_entries" (
        "id"              uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid                NOT NULL REFERENCES "kindergartens"("id"),
        "child_id"        uuid                NOT NULL REFERENCES "children"("id"),
        "entry_type"      timeline_entry_type NOT NULL,
        "title"           varchar(255),
        "body"            text,
        "media_urls"      text[],
        "metadata"        jsonb,
        "recorded_by"     uuid                         REFERENCES "staff_members"("id"),
        "entry_time"      timestamptz         NOT NULL DEFAULT now(),
        "created_at"      timestamptz         NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_timeline_child_time"
        ON "timeline_entries" ("child_id", "entry_time" DESC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "timeline_entries" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "timeline_entries" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "timeline_entries"
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
    // Reverse order: timeline_entries → child_daily_status → attendance_events → ENUMs

    // 7. timeline_entries
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "timeline_entries"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "timeline_entries" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "timeline_entries" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_timeline_child_time"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "timeline_entries"`);

    // 6. child_daily_status
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "child_daily_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_daily_status" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_daily_status" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_daily_status_kg_date"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_daily_status_child_date"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "child_daily_status"`);

    // 5. attendance_events
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "attendance_events"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "attendance_events" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "attendance_events" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_attendance_child_recorded"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_attendance_kg_recorded"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "attendance_events"`);

    // 4. timeline_entry_type ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS timeline_entry_type`);

    // 3. child_intraday_status ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS child_intraday_status`);

    // 2. attendance_method ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS attendance_method`);

    // 1. attendance_event_type ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS attendance_event_type`);
  }
}
