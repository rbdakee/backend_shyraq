import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P4 — Organization tables.
 *
 *   - locations              (tenant-scoped, simple CRUD)
 *   - groups                 (tenant-scoped, rich aggregate)
 *   - group_mentors          (tenant-scoped, partial-unique on active rows)
 *   - cameras                (tenant-scoped, links to a location)
 *
 * Plus column extensions on the existing `staff_members` table to support
 * archived_at / metadata that the P3 minimal seed left out.
 *
 * Each tenant-scoped table gets the same RLS shape as the P3 staff_members:
 *   ENABLE + FORCE ROW LEVEL SECURITY,
 *   policy `tenant_isolation`
 *     USING (bypass_rls = 'true' OR kindergarten_id = app.kindergarten_id::uuid)
 *     WITH CHECK (same).
 * Every relational FK fans out from `kindergartens(id)` so a hard-delete of a
 * tenant cleanly removes all child rows. No FK to `users(id)` from the new
 * tables — staff are linked through staff_members.id, never directly to users.
 *
 * The partial-unique idx_group_mentors_one_active enforces the core domain
 * invariant: a group has at most one *active* mentor (unassigned_at IS NULL)
 * at a time. Re-assigning closes the old row in the same TX before inserting
 * the new one; if a race tries to write two active rows, the unique index
 * surfaces 23505 which the service maps to a domain error.
 */
export class OrganizationTables1777593603000 implements MigrationInterface {
  name = 'OrganizationTables1777593603000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. staff_members extension ──────────────────────────────────────
    // archived_at: distinct from is_active so we can treat "fired but
    // re-hireable" differently from "soft-deleted forever". Coexists with
    // is_active for now.
    await queryRunner.query(
      `ALTER TABLE "staff_members" ADD COLUMN IF NOT EXISTS "full_name" varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "staff_members" ADD COLUMN IF NOT EXISTS "phone" varchar(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "staff_members" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz`,
    );

    // ── 2. locations ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "locations" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "name"            varchar(255) NOT NULL,
        "description"     text,
        "archived_at"     timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_locations_kg" ON "locations" ("kindergarten_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`ALTER TABLE "locations" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "locations"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. groups ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "groups" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"     uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "name"                varchar(255) NOT NULL,
        "capacity"            integer NOT NULL,
        "age_range_min"       integer,
        "age_range_max"       integer,
        "current_location_id" uuid REFERENCES "locations"("id") ON DELETE SET NULL,
        "archived_at"         timestamptz,
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT groups_capacity_chk CHECK (capacity > 0),
        CONSTRAINT groups_age_range_chk CHECK (
          age_range_min IS NULL
          OR age_range_max IS NULL
          OR age_range_min < age_range_max
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_groups_kg" ON "groups" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_groups_location" ON "groups" ("current_location_id")`,
    );

    await queryRunner.query(`ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "groups" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "groups"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 4. group_mentors ────────────────────────────────────────────────
    // Partial-unique idx enforces: at most one active mentor per group at a
    // time (unassigned_at IS NULL). Closing the old row + inserting the new
    // one happens in the same TX in the service layer.
    await queryRunner.query(`
      CREATE TABLE "group_mentors" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "group_id"        uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
        "staff_member_id" uuid NOT NULL REFERENCES "staff_members"("id") ON DELETE CASCADE,
        "is_primary"      boolean NOT NULL DEFAULT true,
        "assigned_at"     timestamptz NOT NULL DEFAULT now(),
        "unassigned_at"   timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_group_mentors_kg" ON "group_mentors" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_group_mentors_group" ON "group_mentors" ("group_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_group_mentors_staff" ON "group_mentors" ("staff_member_id")`,
    );
    // Core invariant — one active mentor per group at a time.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_group_mentors_one_active"
        ON "group_mentors" ("group_id")
        WHERE "unassigned_at" IS NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "group_mentors" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_mentors" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "group_mentors"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 5. cameras ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "cameras" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "location_id"     uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
        "name"            varchar(255) NOT NULL,
        "rtsp_url"        varchar(1000) NOT NULL,
        "hls_url"         varchar(1000),
        "is_active"       boolean NOT NULL DEFAULT true,
        "archived_at"     timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_cameras_kg" ON "cameras" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_cameras_location" ON "cameras" ("location_id")`,
    );

    await queryRunner.query(`ALTER TABLE "cameras" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "cameras" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "cameras"
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
    // 5. cameras
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "cameras"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "cameras" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "cameras" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cameras_location"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_cameras_kg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cameras"`);

    // 4. group_mentors
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "group_mentors"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "group_mentors" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "group_mentors" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_group_mentors_one_active"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_group_mentors_staff"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_group_mentors_group"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_group_mentors_kg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "group_mentors"`);

    // 3. groups
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "groups"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "groups" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "groups" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_groups_location"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_groups_kg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "groups"`);

    // 2. locations
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "locations"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "locations" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "locations" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_locations_kg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "locations"`);

    // 1. staff_members extension
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "staff_members" DROP COLUMN IF EXISTS "archived_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "staff_members" DROP COLUMN IF EXISTS "phone"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "staff_members" DROP COLUMN IF EXISTS "full_name"`,
    );
  }
}
