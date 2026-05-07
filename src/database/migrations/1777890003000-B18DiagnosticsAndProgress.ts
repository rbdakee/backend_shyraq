import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B18 — Diagnostics & Progress (BP §8).
 *
 * Creates three tenant-scoped tables:
 *   1. diagnostic_templates  — configurable per-kg templates (specialist-type scoped)
 *   2. diagnostic_entries    — filled assessment records per child
 *   3. progress_notes        — mentor notes per child (no updated_at — append-only)
 *
 * No new ENUMs: specialist_type is plain varchar.
 *
 * RLS pattern identical to B16 (tenant_isolation policy):
 *   FORCE ROW LEVEL SECURITY; coalesce(bypass_rls, 'false') = 'true'
 *   OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
 *
 * REVOKE TRUNCATE: runtime role (shyraq_app) must not be able to TRUNCATE tenant
 *   tables (defence-in-depth, B11+ pattern).
 *
 * Triggers: diagnostic_templates + diagnostic_entries have updated_at BEFORE UPDATE
 *   triggers. progress_notes does NOT (only created_at + noted_at per schema).
 *   The shared update_updated_at_column() function is re-CREATE OR REPLACE'd
 *   (idempotent — safe to run even if B16 already created it).
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES in InitExtensions.
 */
export class B18DiagnosticsAndProgress1777890003000 implements MigrationInterface {
  name = 'B18DiagnosticsAndProgress1777890003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 0. Shared trigger function (idempotent) ────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER
        LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$
    `);

    // ── 1. diagnostic_templates ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "diagnostic_templates" (
        "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"   uuid        NOT NULL
                              REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "specialist_type"   varchar     NOT NULL,
        "name"              varchar     NOT NULL,
        "description"       text,
        "version"           int         NOT NULL DEFAULT 1,
        "is_active"         boolean     NOT NULL DEFAULT true,
        "schema"            jsonb       NOT NULL,
        "created_by"        uuid        NOT NULL
                              REFERENCES "staff_members"("id") ON DELETE RESTRICT,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_diagnostic_templates_version_min"
          CHECK ("version" >= 1)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_diagnostic_templates_kg_specialist_type"
        ON "diagnostic_templates" ("kindergarten_id", "specialist_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_diagnostic_templates_kg_active"
        ON "diagnostic_templates" ("kindergarten_id")
        WHERE "is_active" = true`,
    );

    await queryRunner.query(
      `ALTER TABLE "diagnostic_templates" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "diagnostic_templates" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "diagnostic_templates"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_diagnostic_templates_updated_at"
        BEFORE UPDATE ON "diagnostic_templates"
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);

    // ── 2. diagnostic_entries ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "diagnostic_entries" (
        "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"   uuid        NOT NULL
                              REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"          uuid        NOT NULL
                              REFERENCES "children"("id") ON DELETE CASCADE,
        "template_id"       uuid        NOT NULL
                              REFERENCES "diagnostic_templates"("id") ON DELETE RESTRICT,
        "specialist_id"     uuid        NOT NULL
                              REFERENCES "staff_members"("id") ON DELETE RESTRICT,
        "assessment_date"   date        NOT NULL,
        "data"              jsonb       NOT NULL,
        "summary"           text,
        "recommendations"   text,
        "attachments"       text[],
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_diagnostic_entries_assessment_date_not_future"
          CHECK ("assessment_date" <= CURRENT_DATE)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_diagnostic_entries_child_date"
        ON "diagnostic_entries" ("child_id", "assessment_date" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_diagnostic_entries_kg_date"
        ON "diagnostic_entries" ("kindergarten_id", "assessment_date" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_diagnostic_entries_specialist_date"
        ON "diagnostic_entries" ("specialist_id", "assessment_date" DESC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "diagnostic_entries" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "diagnostic_entries" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "diagnostic_entries"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_diagnostic_entries_updated_at"
        BEFORE UPDATE ON "diagnostic_entries"
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);

    // ── 3. progress_notes ─────────────────────────────────────────────────────
    // Note: no updated_at column per schema (append-only notes).
    await queryRunner.query(`
      CREATE TABLE "progress_notes" (
        "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"   uuid        NOT NULL
                              REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"          uuid        NOT NULL
                              REFERENCES "children"("id") ON DELETE CASCADE,
        "mentor_id"         uuid        NOT NULL
                              REFERENCES "staff_members"("id") ON DELETE RESTRICT,
        "body"              text        NOT NULL,
        "media_urls"        text[],
        "noted_at"          timestamptz NOT NULL DEFAULT now(),
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_progress_notes_noted_at_not_far_future"
          CHECK ("noted_at" <= NOW() + interval '5 minutes')
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_progress_notes_child_noted_at"
        ON "progress_notes" ("child_id", "noted_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_progress_notes_mentor_noted_at"
        ON "progress_notes" ("mentor_id", "noted_at" DESC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "progress_notes" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "progress_notes" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "progress_notes"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // No updated_at trigger for progress_notes (schema: only created_at + noted_at)

    // ── 4. REVOKE TRUNCATE (defence-in-depth per B13/B16 pattern) ─────────────
    await queryRunner.query(
      `REVOKE TRUNCATE ON "diagnostic_templates", "diagnostic_entries", "progress_notes" FROM "shyraq_app"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse FK-dependency order:
    // progress_notes → diagnostic_entries → diagnostic_templates

    // ── progress_notes ────────────────────────────────────────────────────────
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "progress_notes"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "progress_notes" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "progress_notes" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_progress_notes_mentor_noted_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_progress_notes_child_noted_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "progress_notes"`);

    // ── diagnostic_entries ────────────────────────────────────────────────────
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_diagnostic_entries_updated_at" ON "diagnostic_entries"`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "diagnostic_entries"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "diagnostic_entries" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "diagnostic_entries" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_diagnostic_entries_specialist_date"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_diagnostic_entries_kg_date"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_diagnostic_entries_child_date"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "diagnostic_entries"`);

    // ── diagnostic_templates ──────────────────────────────────────────────────
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_diagnostic_templates_updated_at" ON "diagnostic_templates"`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "diagnostic_templates"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "diagnostic_templates" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "diagnostic_templates" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_diagnostic_templates_kg_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_diagnostic_templates_kg_specialist_type"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "diagnostic_templates"`);
  }
}
