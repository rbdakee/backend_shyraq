import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3 — tenant bootstrap.
 *
 * 1. Adds `kindergartens.archived_at` (timestamptz, nullable). Coexists with
 *    the legacy `is_active` flag so older code keeps working while new code
 *    relies on the timestamp.
 * 2. Creates `staff_members` (tenant-scoped) with FK→kindergartens.id +
 *    FK→users.id. ENABLE + FORCE ROW LEVEL SECURITY plus a `tenant_isolation`
 *    policy that mirrors the one on refresh_tokens (matches
 *    `app.kindergarten_id`, allows `app.bypass_rls` for SuperAdmin).
 * 3. Adds the partial unique index documented in plans/schema.dbml — only
 *    one *active* staff row per (kindergarten, user). Inactive duplicates
 *    are allowed so deactivate→reactivate cycles do not collide.
 *
 * Grants on the new table flow through the ALTER DEFAULT PRIVILEGES set up
 * in InitExtensions; no extra GRANT is needed here because the migration is
 * run as the table owner (`shyraq` / superuser) and `shyraq_app` picks up
 * the default privileges.
 */
export class StaffAndKindergartenSettings1777593602000 implements MigrationInterface {
  name = 'StaffAndKindergartenSettings1777593602000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. kindergartens.archived_at
    await queryRunner.query(
      `ALTER TABLE "kindergartens" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz`,
    );

    // 2. staff_members
    await queryRunner.query(`
      CREATE TABLE "staff_members" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role"            varchar(32) NOT NULL,
        "specialist_type" varchar(64),
        "is_active"       boolean NOT NULL DEFAULT true,
        "hired_at"        date,
        "fired_at"        date,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT staff_members_role_chk
          CHECK (role IN ('admin','mentor','specialist','reception'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_staff_members_kg_role" ON "staff_members" ("kindergarten_id", "role")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_staff_members_user" ON "staff_members" ("user_id")`,
    );
    // One active staff_members row per (kg, user). Inactive rows are exempt
    // so deactivate→reactivate cycles do not collide on the unique index.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_staff_members_kg_user_active"
        ON "staff_members" ("kindergarten_id", "user_id")
        WHERE "is_active" = true
    `);

    // 3. RLS — staff_members is tenant-scoped on kindergarten_id.
    await queryRunner.query(
      `ALTER TABLE "staff_members" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "staff_members" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "staff_members"
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
      `DROP POLICY IF EXISTS tenant_isolation ON "staff_members"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "staff_members" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "staff_members" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_staff_members_kg_user_active"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_staff_members_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_staff_members_kg_role"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "staff_members"`);
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "kindergartens" DROP COLUMN IF EXISTS "archived_at"`,
    );
  }
}
