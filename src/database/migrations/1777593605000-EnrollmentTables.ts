import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B5 — Enrollment Tables.
 *
 *   - enrollment_status    (ENUM type)
 *   - enrollments          (tenant-scoped, lead/inquiry aggregate)
 *   - enrollment_status_log (tenant-scoped, append-only audit log)
 *
 * RLS shape identical to P5 (ChildrenAndGuardians):
 *   ENABLE + FORCE ROW LEVEL SECURITY,
 *   policy `tenant_isolation`
 *     USING  (bypass_rls = 'true' OR kindergarten_id = app.kindergarten_id::uuid)
 *     WITH CHECK (same).
 *
 * child_id references children(id) ON DELETE SET NULL — enrollment outlives
 * child card deletion (the lead record must be preserved for audit).
 * enrollment_status_log.changed_by references staff_members(id) ON DELETE RESTRICT
 * — log rows must never be silently removed when a staff member is deleted.
 */
export class EnrollmentTables1777501179271 implements MigrationInterface {
  name = 'EnrollmentTables1777501179271';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. enrollment_status ENUM ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE enrollment_status AS ENUM (
        'new',
        'in_processing',
        'waitlist',
        'card_created',
        'cancelled',
        'archive'
      )
    `);

    // ── 2. enrollments ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "enrollments" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"   uuid NOT NULL REFERENCES "kindergartens"("id"),
        "child_id"          uuid REFERENCES "children"("id") ON DELETE SET NULL,
        "contact_name"      varchar NOT NULL,
        "contact_phone"     varchar NOT NULL,
        "child_name"        varchar,
        "child_dob"         date,
        "child_iin"         char(12),
        "status"            enrollment_status NOT NULL DEFAULT 'new',
        "source"            varchar,
        "notes"             text,
        "assigned_to"       uuid REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "status_changed_at" timestamptz NOT NULL DEFAULT now(),
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_enrollments_kg_status" ON "enrollments" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_enrollments_kg_phone" ON "enrollments" ("kindergarten_id", "contact_phone")`,
    );
    await queryRunner.query(`
      CREATE INDEX "idx_enrollments_kg_iin"
        ON "enrollments" ("kindergarten_id", "child_iin")
        WHERE "child_iin" IS NOT NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "enrollments" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "enrollments" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "enrollments"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. enrollment_status_log ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "enrollment_status_log" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "enrollment_id"   uuid NOT NULL REFERENCES "enrollments"("id") ON DELETE CASCADE,
        "kindergarten_id" uuid NOT NULL REFERENCES "kindergartens"("id"),
        "from_status"     enrollment_status,
        "to_status"       enrollment_status NOT NULL,
        "changed_by"      uuid NOT NULL REFERENCES "staff_members"("id") ON DELETE RESTRICT,
        "comment"         text,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_enrollment_log_enrollment"
        ON "enrollment_status_log" ("enrollment_id", "created_at" DESC)
    `);

    await queryRunner.query(
      `ALTER TABLE "enrollment_status_log" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "enrollment_status_log" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "enrollment_status_log"
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
    // 3. enrollment_status_log
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "enrollment_status_log"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "enrollment_status_log" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "enrollment_status_log" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_enrollment_log_enrollment"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "enrollment_status_log"`);

    // 2. enrollments
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "enrollments"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "enrollments" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "enrollments" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_enrollments_kg_iin"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_enrollments_kg_phone"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_enrollments_kg_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "enrollments"`);

    // 1. enrollment_status ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS enrollment_status`);
  }
}
