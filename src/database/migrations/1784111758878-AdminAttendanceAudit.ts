import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin Attendance Audit — audit trail + soft-delete + timeline↔event link.
 *
 * Changes (order respects FK deps):
 *   1. audit_log                        (tenant-scoped; append-only mutation log)
 *   2. attendance_events.deleted_at     (soft-delete marker + live partial index)
 *   3. timeline_entries.source_event_id (FK→attendance_events.id + partial index)
 *   4. Backfill of timeline_entries.source_event_id for historical rows
 *
 * RLS pattern identical to B8 (AttendanceAndTimeline):
 *   ENABLE + FORCE ROW LEVEL SECURITY, policy `tenant_isolation`
 *   USING + WITH CHECK via coalesce(bypass_rls) OR kindergarten_id = setting::uuid.
 *
 * `entity_type` is deliberately NOT constrained by a CHECK — B8 attendance is
 * the first writer ('attendance_event' | 'child_daily_status'), but the table is
 * meant to absorb future modules without a migration per entity kind. `action`
 * IS constrained (audit_log_action_chk), mirroring staff_members_role_chk.
 *
 * `actor_user_id` / `actor_staff_id` are both nullable and independent: a
 * mutation can originate from a staff member (both set), a system/CLI path (both
 * null), or a plain user (only user set). No XOR check — over-constraining an
 * append-only audit sink risks losing the record entirely on an edge case.
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions — no
 * per-table GRANT needed for new tables created by the migration owner role.
 */
export class AdminAttendanceAudit1784111758878 implements MigrationInterface {
  name = 'AdminAttendanceAudit1784111758878';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. audit_log ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid        NOT NULL REFERENCES "kindergartens"("id"),
        "entity_type"     varchar(64) NOT NULL,
        "entity_id"       uuid        NOT NULL,
        "action"          varchar(32) NOT NULL,
        "actor_user_id"   uuid                 REFERENCES "users"("id"),
        "actor_staff_id"  uuid                 REFERENCES "staff_members"("id"),
        "before"          jsonb,
        "after"           jsonb,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT audit_log_action_chk
          CHECK (action IN ('create','update','delete'))
      )
    `);

    // Per-entity history lookup — the read path of AuditService.listByEntity.
    await queryRunner.query(`
      CREATE INDEX "idx_audit_entity"
        ON "audit_log" ("kindergarten_id", "entity_type", "entity_id", "created_at" DESC)
    `);
    // Tenant-wide reverse-chronological feed.
    await queryRunner.query(`
      CREATE INDEX "idx_audit_kg_created"
        ON "audit_log" ("kindergarten_id", "created_at" DESC)
    `);

    await queryRunner.query(
      `ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "audit_log"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 2. attendance_events.deleted_at (soft delete) ─────────────────────────
    await queryRunner.query(
      `ALTER TABLE "attendance_events" ADD COLUMN "deleted_at" timestamptz`,
    );
    // Partial twin of idx_attendance_kg_recorded: live-list queries filter
    // `deleted_at IS NULL`, so the partial index keeps those plans tight without
    // paying for tombstones.
    await queryRunner.query(`
      CREATE INDEX "idx_attendance_kg_recorded_live"
        ON "attendance_events" ("kindergarten_id", "recorded_at" DESC)
        WHERE "deleted_at" IS NULL
    `);

    // ── 3. timeline_entries.source_event_id ───────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "timeline_entries"
        ADD COLUMN "source_event_id" uuid REFERENCES "attendance_events"("id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_timeline_source_event"
        ON "timeline_entries" ("source_event_id")
        WHERE "source_event_id" IS NOT NULL
    `);

    // ── 4. Backfill timeline_entries.source_event_id ──────────────────────────
    //
    // Both tables are FORCE ROW LEVEL SECURITY, so `tenant_isolation` applies to
    // the table owner too. The migration role is normally a SUPERUSER (`shyraq`),
    // which PostgreSQL exempts from RLS outright — but the managed-DB prod role is
    // only required to hold CREATEROLE (MEMORY.md §5), and a non-superuser owner
    // under FORCE would silently match ZERO rows here, since `app.kindergarten_id`
    // is unset outside the HTTP pipeline. Setting the bypass GUC makes the
    // backfill correct under both roles. SET LOCAL is scoped to this migration's
    // transaction (TypeORM default migrationsTransactionMode = 'all'), so it
    // cannot leak to the runtime pool.
    await queryRunner.query(`SET LOCAL app.bypass_rls = 'true'`);

    // AttendanceService.checkIn/checkOut writes the event and its timeline entry
    // in ONE transaction off the same in-memory timestamp, so historical pairs
    // satisfy `entry_time = recorded_at` exactly, and `entry_type::text =
    // event_type::text` for the check_in/check_out kinds.
    //
    // The match is best-effort and NOT guaranteed unique: a child can legitimately
    // hold two identical events at the same microsecond (double-tap, replayed
    // request). `UPDATE ... FROM` would silently pick an arbitrary row in that
    // case, so the event id instead comes from a correlated subquery under a TOTAL
    // order — `ORDER BY ae.created_at, ae.id LIMIT 1`. The `ae.id` tiebreaker keeps
    // the choice deterministic when created_at also ties, and LIMIT 1 makes the
    // statement structurally incapable of raising 21000 ("more than one row
    // returned by a subquery used as an expression").
    //
    // The EXISTS guard confines the write to rows that actually matched; without
    // it the subquery would write NULL over NULL and rewrite every unmatched row
    // for nothing. No `deleted_at` filter is needed — the column was added moments
    // ago in step 2, so every event is live at backfill time.
    await queryRunner.query(`
      UPDATE "timeline_entries" te
         SET "source_event_id" = (
               SELECT ae."id"
                 FROM "attendance_events" ae
                WHERE ae."kindergarten_id"  = te."kindergarten_id"
                  AND ae."child_id"         = te."child_id"
                  AND ae."event_type"::text = te."entry_type"::text
                  AND ae."recorded_at"      = te."entry_time"
                ORDER BY ae."created_at", ae."id"
                LIMIT 1
             )
       WHERE te."entry_type" IN ('check_in', 'check_out')
         AND te."source_event_id" IS NULL
         AND EXISTS (
               SELECT 1
                 FROM "attendance_events" ae
                WHERE ae."kindergarten_id"  = te."kindergarten_id"
                  AND ae."child_id"         = te."child_id"
                  AND ae."event_type"::text = te."entry_type"::text
                  AND ae."recorded_at"      = te."entry_time"
             )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: source_event_id → deleted_at → audit_log.
    // The step-4 backfill needs no explicit undo — dropping the column discards it.

    // 3. timeline_entries.source_event_id
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_timeline_source_event"`);
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "timeline_entries" DROP COLUMN IF EXISTS "source_event_id"`,
    );

    // 2. attendance_events.deleted_at
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_attendance_kg_recorded_live"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "attendance_events" DROP COLUMN IF EXISTS "deleted_at"`,
    );

    // 1. audit_log
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "audit_log"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "audit_log" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "audit_log" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_kg_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_audit_entity"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log"`);
  }
}
