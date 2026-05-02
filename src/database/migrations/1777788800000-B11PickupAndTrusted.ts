import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B11 — Pickup & Trusted People.
 *
 * Creates two new tenant-scoped tables:
 *   1. trusted_people   — reusable per-child whitelist of authorised pickup persons
 *   2. pickup_requests  — OTP-based pickup request flow (otp_sent → validated | expired | cancelled)
 *
 * Also creates ENUM `pickup_request_status`.
 *
 * NOTE on `attendance_method` ENUM:
 *   Value 'otp_pickup' was already added in B8 (B8AttendanceAndTimeline migration).
 *   No ALTER TYPE needed here.
 *
 * NOTE on `pickup_request_id` FK on `attendance_events`:
 *   The column already exists (nullable, no FK) since B8.
 *   B11 adds the FK constraint pointing at pickup_requests(id).
 *
 * NOTE on `parent_request_id` on `pickup_requests`:
 *   Stored as plain uuid with NO FK — the `parent_requests` table is added in B12.
 *   The FK will be added in B12 via ALTER TABLE.
 *
 * RLS pattern identical to B8/B9 (tenant_isolation policy):
 *   ENABLE + FORCE ROW LEVEL SECURITY; policy uses coalesce(bypass_rls) OR kindergarten_id = setting::uuid.
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions.
 */
export class B11PickupAndTrusted1777788800000 implements MigrationInterface {
  name = 'B11PickupAndTrusted1777788800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. pickup_request_status ENUM ────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE pickup_request_status AS ENUM (
        'otp_sent',
        'validated',
        'expired',
        'cancelled'
      )
    `);

    // ── 2. trusted_people ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "trusted_people" (
        "id"               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid         NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"         uuid         NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "added_by_user_id" uuid         NOT NULL REFERENCES "users"("id"),
        "full_name"        text         NOT NULL,
        "phone"            varchar(20)  NOT NULL,
        "iin"              char(12),
        "relation"         text         NOT NULL,
        "photo_url"        text,
        "is_active"        boolean      NOT NULL DEFAULT true,
        "is_one_time"      boolean      NOT NULL DEFAULT false,
        "used_at"          timestamptz,
        "created_at"       timestamptz  NOT NULL DEFAULT now(),
        "revoked_at"       timestamptz
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_trusted_people_child_active"
        ON "trusted_people" ("child_id", "is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_trusted_people_kg_child"
        ON "trusted_people" ("kindergarten_id", "child_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "trusted_people" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "trusted_people" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "trusted_people"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. pickup_requests ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "pickup_requests" (
        "id"                   uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"      uuid                   NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"             uuid                   NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "requested_by_user_id" uuid                   NOT NULL REFERENCES "users"("id"),
        "trusted_person_id"    uuid                             REFERENCES "trusted_people"("id") ON DELETE SET NULL,
        "trusted_person_phone" varchar(20)            NOT NULL,
        "trusted_person_name"  text                   NOT NULL,
        "trusted_person_iin"   char(12),
        "otp_ref"              text,
        "status"               pickup_request_status  NOT NULL DEFAULT 'otp_sent',
        "validated_by"         uuid                             REFERENCES "staff_members"("id"),
        "validated_at"         timestamptz,
        "attendance_event_id"  uuid                             REFERENCES "attendance_events"("id"),
        "parent_request_id"    uuid,
        "expires_at"           timestamptz            NOT NULL,
        "created_at"           timestamptz            NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_pickup_requests_kg_status"
        ON "pickup_requests" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_pickup_requests_child_created"
        ON "pickup_requests" ("child_id", "created_at" DESC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "pickup_requests" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "pickup_requests" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "pickup_requests"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 4. Add FK on attendance_events.pickup_request_id → pickup_requests ───
    // The column already exists (nullable, no FK) since B8 migration.
    await queryRunner.query(`
      ALTER TABLE "attendance_events"
        ADD CONSTRAINT "fk_attendance_events_pickup_request"
        FOREIGN KEY ("pickup_request_id")
        REFERENCES "pickup_requests"("id")
        ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: FK → pickup_requests → trusted_people → ENUM

    // 4. Drop FK on attendance_events
    await queryRunner.query(`
      ALTER TABLE "attendance_events"
        DROP CONSTRAINT IF EXISTS "fk_attendance_events_pickup_request"
    `);

    // 3. pickup_requests
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "pickup_requests"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "pickup_requests" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "pickup_requests" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_pickup_requests_child_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_pickup_requests_kg_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "pickup_requests"`);

    // 2. trusted_people
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "trusted_people"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "trusted_people" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "trusted_people" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_trusted_people_kg_child"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_trusted_people_child_active"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "trusted_people"`);

    // 1. pickup_request_status ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS pickup_request_status`);
  }
}
