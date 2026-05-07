import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B17 — Content & Stories (BP §9).
 *
 * Creates two tenant-scoped tables:
 *   1. content_posts   — news / menu / schedule_pub / qundylyq / birthday posts
 *   2. group_stories   — 24h ephemeral media stories per group
 *
 * New ENUMs (3):
 *   - content_type        — news | menu | schedule_pub | qundylyq | birthday
 *   - content_target_type — all | group | child
 *   - content_status      — draft | scheduled | published
 *
 * RLS pattern identical to B16 (tenant_isolation policy + FORCE RLS):
 *   coalesce(bypass_rls, 'false') = 'true'
 *   OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
 *
 * REVOKE TRUNCATE: runtime role (shyraq_app) must not be able to TRUNCATE
 *   tenant tables (defence-in-depth per B13/B16 pattern).
 *
 * Note on created_by FK: schema.dbml references staff_members.id but the
 *   B13 FK-fix migration established the precedent that controllers write
 *   req.user.sub = users.id as created_by. This migration follows that
 *   precedent and references users(id) on both tables.
 *
 * update_updated_at_column() trigger function was created via B16 migration
 *   using CREATE OR REPLACE — safe to call again here for idempotency.
 */
export class B17ContentAndStories1777890002000 implements MigrationInterface {
  name = 'B17ContentAndStories1777890002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. ENUMs (idempotent — DO $$ ... EXCEPTION WHEN duplicate_object) ──────

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "content_type" AS ENUM (
          'news',
          'menu',
          'schedule_pub',
          'qundylyq',
          'birthday'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "content_target_type" AS ENUM (
          'all',
          'group',
          'child'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "content_status" AS ENUM (
          'draft',
          'scheduled',
          'published'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    // ── 2. content_posts ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "content_posts" (
        "id"               uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid                    NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "content_type"     "content_type"          NOT NULL,
        "target_type"      "content_target_type"   NOT NULL DEFAULT 'all',
        "target_group_id"  uuid                    REFERENCES "groups"("id") ON DELETE CASCADE,
        "target_child_id"  uuid                    REFERENCES "children"("id") ON DELETE CASCADE,
        "title"            varchar(500),
        "body"             text,
        "title_i18n"       jsonb,
        "body_i18n"        jsonb,
        "media_urls"       text[],
        "metadata"         jsonb,
        "scheduled_for"    timestamptz,
        "published_at"     timestamptz,
        "expires_at"       timestamptz,
        "status"           "content_status"        NOT NULL DEFAULT 'draft',
        "created_by"       uuid                    REFERENCES "users"("id"),
        "created_at"       timestamptz             NOT NULL DEFAULT now(),
        "updated_at"       timestamptz             NOT NULL DEFAULT now(),
        CONSTRAINT "content_posts_target_invariant_check"
          CHECK (
            (target_type = 'all'   AND target_group_id IS NULL AND target_child_id IS NULL)
            OR (target_type = 'group' AND target_group_id IS NOT NULL AND target_child_id IS NULL)
            OR (target_type = 'child' AND target_child_id IS NOT NULL AND target_group_id IS NULL)
          )
      )
    `);

    // Indexes
    await queryRunner.query(
      `CREATE INDEX "idx_content_posts_kg_published_at"
        ON "content_posts" ("kindergarten_id", "published_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_content_posts_kg_type_status"
        ON "content_posts" ("kindergarten_id", "content_type", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_content_posts_kg_scheduled_for"
        ON "content_posts" ("kindergarten_id", "scheduled_for")
        WHERE "status" = 'scheduled'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_content_posts_target_group"
        ON "content_posts" ("kindergarten_id", "target_group_id")
        WHERE "target_group_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_content_posts_target_child"
        ON "content_posts" ("kindergarten_id", "target_child_id")
        WHERE "target_child_id" IS NOT NULL`,
    );

    // RLS
    await queryRunner.query(
      `ALTER TABLE "content_posts" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "content_posts" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "content_posts"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // updated_at trigger — reuse shared helper (B16 created it via CREATE OR REPLACE)
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

    await queryRunner.query(`
      CREATE TRIGGER "trg_content_posts_updated_at"
        BEFORE UPDATE ON "content_posts"
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);

    // REVOKE TRUNCATE
    await queryRunner.query(
      `REVOKE TRUNCATE ON "content_posts" FROM "shyraq_app"`,
    );

    // ── 3. group_stories ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "group_stories" (
        "id"               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid          NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "group_id"         uuid          NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
        "created_by"       uuid          NOT NULL REFERENCES "users"("id"),
        "media_url"        text          NOT NULL,
        "media_type"       varchar(16)   NOT NULL,
        "caption"          text,
        "views"            int           NOT NULL DEFAULT 0,
        "expires_at"       timestamptz   NOT NULL,
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "group_stories_media_type_check"
          CHECK ("media_type" IN ('image', 'video'))
      )
    `);

    // Indexes
    await queryRunner.query(
      `CREATE INDEX "idx_group_stories_expires_at"
        ON "group_stories" ("expires_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_group_stories_group_expires_at"
        ON "group_stories" ("group_id", "expires_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_group_stories_kg_expires_at"
        ON "group_stories" ("kindergarten_id", "expires_at")`,
    );

    // RLS
    await queryRunner.query(
      `ALTER TABLE "group_stories" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "group_stories" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "group_stories"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // REVOKE TRUNCATE
    await queryRunner.query(
      `REVOKE TRUNCATE ON "group_stories" FROM "shyraq_app"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse dependency order.

    // group_stories
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "group_stories"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "group_stories" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "group_stories" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_group_stories_kg_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_group_stories_group_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_group_stories_expires_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "group_stories"`);

    // content_posts
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_content_posts_updated_at" ON "content_posts"`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "content_posts"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "content_posts" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "content_posts" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_content_posts_target_child"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_content_posts_target_group"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_content_posts_kg_scheduled_for"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_content_posts_kg_type_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_content_posts_kg_published_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "content_posts"`);

    // ENUMs (after all referencing tables are dropped)
    // Note: do NOT drop update_updated_at_column() — shared with B16
    await queryRunner.query(`DROP TYPE IF EXISTS "content_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "content_target_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "content_type"`);
  }
}
