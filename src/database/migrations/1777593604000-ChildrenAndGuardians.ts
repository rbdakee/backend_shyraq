import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P5 — Children & Guardians.
 *
 *   - children                (tenant-scoped, rich aggregate)
 *   - child_group_history     (tenant-scoped, append-only audit)
 *   - child_guardians         (tenant-scoped, state-machine + permissions JSONB)
 *
 * Each tenant-scoped table gets the same RLS shape as the P3/P4 tables:
 *   ENABLE + FORCE ROW LEVEL SECURITY,
 *   policy `tenant_isolation`
 *     USING (bypass_rls = 'true' OR kindergarten_id = app.kindergarten_id::uuid)
 *     WITH CHECK (same).
 *
 * Indexes/constraints encoding domain invariants:
 *   - `idx_children_iin_kindergarten` partial-unique (kindergarten_id, iin)
 *     WHERE iin IS NOT NULL — "one IIN per kindergarten" without blocking
 *     IIN-less card-created rows.
 *   - `idx_child_guardians_child_user_unique` partial-unique (child_id, user_id)
 *     — same user cannot have two non-revoked guardian records on the same
 *     child. The service does an explicit pre-check so the resulting error
 *     code is `guardian_already_exists` rather than a raw 23505 leak.
 */
export class ChildrenAndGuardians1777593604000 implements MigrationInterface {
  name = 'ChildrenAndGuardians1777593604000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. children ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "children" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "iin"              char(12),
        "full_name"        varchar(255) NOT NULL,
        "date_of_birth"    date NOT NULL,
        "gender"           char(1),
        "photo_url"        text,
        "status"           varchar(32) NOT NULL DEFAULT 'card_created',
        "current_group_id" uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "enrollment_date"  date,
        "archived_at"      timestamptz,
        "archive_reason"   text,
        "medical_notes"    text,
        "allergy_notes"    text,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT children_status_chk CHECK (status IN ('card_created','active','archived')),
        CONSTRAINT children_gender_chk CHECK (gender IS NULL OR gender IN ('m','f'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_children_kg" ON "children" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_children_kg_status" ON "children" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_children_group" ON "children" ("current_group_id")`,
    );
    // Partial-unique: one IIN per kindergarten, but NULL IINs do not collide.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_children_iin_kindergarten"
        ON "children" ("kindergarten_id", "iin")
        WHERE "iin" IS NOT NULL
    `);

    await queryRunner.query(`ALTER TABLE "children" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "children" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "children"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 2. child_group_history ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "child_group_history" (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"          uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"                 uuid NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "from_group_id"            uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "to_group_id"              uuid REFERENCES "groups"("id") ON DELETE SET NULL,
        "transferred_by_staff_id"  uuid NOT NULL REFERENCES "staff_members"("id") ON DELETE RESTRICT,
        "reason"                   text,
        "transferred_at"           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_child_group_history_kg" ON "child_group_history" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_child_group_history_child" ON "child_group_history" ("child_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "child_group_history" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "child_group_history" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "child_group_history"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. child_guardians ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "child_guardians" (
        "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"        uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"               uuid NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "user_id"                uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role"                   varchar(32) NOT NULL,
        "status"                 varchar(32) NOT NULL DEFAULT 'pending_approval',
        "has_approval_rights"    boolean NOT NULL DEFAULT false,
        "approved_by"            uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "approved_at"            timestamptz,
        "revoked_by"             uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "revoked_at"             timestamptz,
        "can_pickup"             boolean NOT NULL DEFAULT true,
        "permissions"            jsonb NOT NULL DEFAULT '{}'::jsonb,
        "permissions_updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "permissions_updated_at" timestamptz,
        "created_at"             timestamptz NOT NULL DEFAULT now(),
        "updated_at"             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT child_guardians_role_chk CHECK (role IN ('primary','secondary','nanny')),
        CONSTRAINT child_guardians_status_chk CHECK (status IN ('pending_approval','approved','rejected','revoked'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_child_guardians_kg" ON "child_guardians" ("kindergarten_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_child_guardians_child" ON "child_guardians" ("child_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_child_guardians_user" ON "child_guardians" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_child_guardians_kg_status" ON "child_guardians" ("kindergarten_id", "status")`,
    );
    // Partial unique — at most one non-revoked guardian per (child, user).
    // Revoked rows are excluded so a primary can re-invite a previously-revoked
    // user later.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_child_guardians_child_user_unique"
        ON "child_guardians" ("child_id", "user_id")
        WHERE "status" <> 'revoked'
    `);

    await queryRunner.query(
      `ALTER TABLE "child_guardians" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "child_guardians" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "child_guardians"
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
    // 3. child_guardians
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "child_guardians"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_guardians" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_guardians" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_child_guardians_child_user_unique"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_child_guardians_kg_status"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_child_guardians_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_child_guardians_child"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_child_guardians_kg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "child_guardians"`);

    // 2. child_group_history
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "child_group_history"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_group_history" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_group_history" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_child_group_history_child"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_child_group_history_kg"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "child_group_history"`);

    // 1. children
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "children"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "children" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "children" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_children_iin_kindergarten"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_children_group"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_children_kg_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_children_kg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "children"`);
  }
}
