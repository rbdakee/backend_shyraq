import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B16 — Custom Discounts (BP §4 extension).
 *
 * Creates two tenant-scoped tables:
 *   1. custom_discounts             — configurable per-kg discount catalogue
 *   2. custom_discount_applications — tracks which discounts were applied to which invoices
 *
 * New ENUMs (2):
 *   - custom_discount_status  — draft | active | paused | expired | cancelled
 *   - custom_discount_type    — percentage | fixed_amount
 *
 * RLS pattern identical to B13 (tenant_isolation policy):
 *   ENABLE + FORCE ROW LEVEL SECURITY; coalesce(bypass_rls, 'false') OR
 *   kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
 *
 * REVOKE TRUNCATE: runtime role (shyraq_app) must not be able to TRUNCATE tenant
 *   tables (defence-in-depth per B13 pattern).
 *
 * Partial index idx_custom_discounts_active on (kindergarten_id, status, valid_from)
 *   WHERE status='active' — fast lookup for currently-active discounts.
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES in InitExtensions.
 */
export class B16CustomDiscounts1777890000000 implements MigrationInterface {
  name = 'B16CustomDiscounts1777890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. ENUMs ──────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "custom_discount_status" AS ENUM (
        'draft',
        'active',
        'paused',
        'expired',
        'cancelled'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "custom_discount_type" AS ENUM (
        'percentage',
        'fixed_amount'
      )
    `);

    // ── 2. custom_discounts ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "custom_discounts" (
        "id"                    uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"       uuid                     NOT NULL REFERENCES "kindergartens"("id"),
        "name"                  jsonb                    NOT NULL,
        "description"           jsonb,
        "discount_type"         "custom_discount_type"   NOT NULL,
        "amount"                numeric(10,2)             NOT NULL,
        "conditions"            jsonb                    NOT NULL DEFAULT '{}'::jsonb,
        "target_type"           varchar                  NOT NULL DEFAULT 'all',
        "target_ids"            uuid[],
        "valid_from"            timestamptz              NOT NULL,
        "valid_until"           timestamptz,
        "max_uses_per_child"    int,
        "total_max_uses"        int,
        "used_count"            int                      NOT NULL DEFAULT 0,
        "priority"              int                      NOT NULL DEFAULT 100,
        "stackable"             boolean                  NOT NULL DEFAULT false,
        "notify_on_activation"  boolean                  NOT NULL DEFAULT true,
        "notification_title"    jsonb,
        "notification_body"     jsonb,
        "status"                "custom_discount_status" NOT NULL DEFAULT 'draft',
        "created_by"            uuid                     REFERENCES "staff_members"("id"),
        "created_at"            timestamptz              NOT NULL DEFAULT now(),
        "updated_at"            timestamptz              NOT NULL DEFAULT now(),
        CONSTRAINT "chk_custom_discounts_amount_positive"
          CHECK ("amount" > 0),
        CONSTRAINT "chk_custom_discounts_validity"
          CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
        CONSTRAINT "chk_custom_discounts_used_count_nonneg"
          CHECK ("used_count" >= 0),
        CONSTRAINT "chk_custom_discounts_priority_nonneg"
          CHECK ("priority" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_custom_discounts_kg_status"
        ON "custom_discounts" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_custom_discounts_valid_from_until"
        ON "custom_discounts" ("valid_from", "valid_until")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_custom_discounts_active"
        ON "custom_discounts" ("kindergarten_id", "status", "valid_from")
        WHERE "status" = 'active'`,
    );

    await queryRunner.query(
      `ALTER TABLE "custom_discounts" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "custom_discounts" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "custom_discounts"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // updated_at trigger — create the shared helper function if it doesn't exist
    // yet, then attach a BEFORE UPDATE trigger to custom_discounts.
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
      CREATE TRIGGER "trg_custom_discounts_updated_at"
        BEFORE UPDATE ON "custom_discounts"
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);

    // ── 3. custom_discount_applications ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "custom_discount_applications" (
        "id"                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"       uuid          NOT NULL REFERENCES "kindergartens"("id"),
        "custom_discount_id"    uuid          NOT NULL REFERENCES "custom_discounts"("id") ON DELETE RESTRICT,
        "invoice_id"            uuid          NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
        "invoice_line_item_id"  uuid          REFERENCES "invoice_line_items"("id") ON DELETE SET NULL,
        "child_id"              uuid          NOT NULL REFERENCES "children"("id") ON DELETE RESTRICT,
        "amount_applied"        numeric(12,2) NOT NULL,
        "applied_at"            timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "chk_custom_discount_applications_amount_positive"
          CHECK ("amount_applied" > 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_custom_discount_applications_discount_id"
        ON "custom_discount_applications" ("custom_discount_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_custom_discount_applications_invoice_id"
        ON "custom_discount_applications" ("invoice_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_custom_discount_applications_child_discount"
        ON "custom_discount_applications" ("child_id", "custom_discount_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "custom_discount_applications" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "custom_discount_applications" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "custom_discount_applications"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 4. REVOKE TRUNCATE (defence-in-depth per B13 pattern) ────────────────
    await queryRunner.query(
      `REVOKE TRUNCATE ON "custom_discounts", "custom_discount_applications" FROM "shyraq_app"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse FK-dependency order.

    // custom_discount_applications
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "custom_discount_applications"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "custom_discount_applications" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "custom_discount_applications" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_custom_discount_applications_child_discount"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_custom_discount_applications_invoice_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_custom_discount_applications_discount_id"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "custom_discount_applications"`,
    );

    // custom_discounts
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_custom_discounts_updated_at" ON "custom_discounts"`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "custom_discounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "custom_discounts" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "custom_discounts" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_custom_discounts_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_custom_discounts_valid_from_until"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_custom_discounts_kg_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "custom_discounts"`);

    // ENUMs (after all referencing tables are dropped)
    await queryRunner.query(`DROP TYPE IF EXISTS "custom_discount_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "custom_discount_status"`);

    // NOTE (B22b T15): A prior revision restored TRUNCATE privilege on
    // `custom_discounts` and `custom_discount_applications` to `shyraq_app`
    // here for symmetry with up(). That GRANT ran AFTER the tables were
    // dropped above, and PostgreSQL rejects `GRANT … ON <missing relation>`
    // with `relation does not exist`, which would fail the entire down().
    // Dropped relations also do not retain privileges, so the GRANT had no
    // effect on a re-up either (up() re-creates the tables and re-applies
    // its own privilege grants). The GRANT has therefore been removed.

    // Drop the shared trigger-helper function. It was created (or replaced)
    // by this migration's up(). No other migration currently calls it, so
    // it is safe to drop on rollback. CASCADE removes any remaining triggers
    // that depend on it (should be zero by the time we reach this line, but
    // CASCADE is defensive against future up() additions).
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE`,
    );
  }
}
