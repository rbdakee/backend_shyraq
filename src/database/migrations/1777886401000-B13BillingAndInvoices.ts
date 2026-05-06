import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B13 — Billing & Invoices (BP §4).
 *
 * Creates eight tenant-scoped tables:
 *   1. tariff_plans            — configurable per-kg tariff catalogue
 *   2. tariff_assignments      — per-child tariff assignment with optional override
 *   3. payment_accounts        — per-child running balance ledger (one per kg)
 *   4. invoices                — state machine pending→{partial,paid,overdue,refunded,cancelled}
 *   5. invoice_line_items      — individual line items for each invoice (RLS-denormalised)
 *   6. payments                — payment attempt lifecycle initiated→{processing,completed,failed,refunded}
 *   7. refunds                 — refund lifecycle pending→{approved→processed,rejected}
 *   8. kindergarten_holidays   — per-kg holiday calendar for pro-rata billing
 *
 * New ENUMs (6):
 *   - tariff_type          — monthly | additional_service | late_pickup_fee | prepayment_3m | prepayment_6m | prepayment_12m | prepayment_24m | other
 *   - tariff_applies_to    — all_children | group | age_range | individual
 *   - payment_type         — monthly | prepayment_3m | prepayment_6m | prepayment_12m | prepayment_24m | additional_service | late_pickup_fee | other
 *   - payment_status       — pending | partial | paid | overdue | refunded | cancelled
 *   - payment_status_v2    — initiated | processing | completed | failed | refunded
 *   - refund_status        — pending | approved | processed | rejected
 *
 * FK ALTER (B12 leftover):
 *   parent_requests.invoice_id → invoices(id) ON DELETE SET NULL
 *   (column was created in B12 as plain uuid with no FK; invoices now exist)
 *
 * Circular FK handled: payments.refund_id → refunds(id) is added via ALTER
 *   after both tables are created (payments created first with refund_id uuid NULL).
 *
 * RLS pattern identical to B12 (tenant_isolation policy):
 *   ENABLE + FORCE ROW LEVEL SECURITY; coalesce(bypass_rls, 'false') OR
 *   kindergarten_id = nullif(current_setting('app.kindergarten_id',true),'')::uuid.
 *
 * REVOKE TRUNCATE: runtime role (shyraq_app) must not be able to TRUNCATE tenant
 *   tables (defence-in-depth per db8cb72 pattern).
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES in InitExtensions.
 */
export class B13BillingAndInvoices1777886401000 implements MigrationInterface {
  name = 'B13BillingAndInvoices1777886401000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. ENUMs ──────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "tariff_type" AS ENUM (
        'monthly',
        'additional_service',
        'late_pickup_fee',
        'prepayment_3m',
        'prepayment_6m',
        'prepayment_12m',
        'prepayment_24m',
        'other'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "tariff_applies_to" AS ENUM (
        'all_children',
        'group',
        'age_range',
        'individual'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "payment_type" AS ENUM (
        'monthly',
        'prepayment_3m',
        'prepayment_6m',
        'prepayment_12m',
        'prepayment_24m',
        'additional_service',
        'late_pickup_fee',
        'other'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "payment_status" AS ENUM (
        'pending',
        'partial',
        'paid',
        'overdue',
        'refunded',
        'cancelled'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "payment_status_v2" AS ENUM (
        'initiated',
        'processing',
        'completed',
        'failed',
        'refunded'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "refund_status" AS ENUM (
        'pending',
        'approved',
        'processed',
        'rejected'
      )
    `);

    // ── 2. tariff_plans ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "tariff_plans" (
        "id"               uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid            NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "name"             text            NOT NULL,
        "description"      jsonb           NOT NULL DEFAULT '{}'::jsonb,
        "tariff_type"      "tariff_type"   NOT NULL,
        "amount"           numeric(12,2)   NOT NULL CHECK ("amount" >= 0),
        "currency"         char(3)         NOT NULL DEFAULT 'KZT',
        "applies_to"       "tariff_applies_to" NOT NULL,
        "group_id"         uuid            REFERENCES "groups"("id") ON DELETE SET NULL,
        "age_min_months"   smallint        CHECK ("age_min_months" >= 0),
        "age_max_months"   smallint        CHECK ("age_max_months" >= 0),
        "is_active"        boolean         NOT NULL DEFAULT true,
        "valid_from"       date            NOT NULL,
        "valid_until"      date,
        "discount_rules"   jsonb           NOT NULL DEFAULT '{}'::jsonb,
        "created_at"       timestamptz     NOT NULL DEFAULT now(),
        "updated_at"       timestamptz     NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_tariff_plans_kg_is_active"
        ON "tariff_plans" ("kindergarten_id", "is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tariff_plans_kg_tariff_type"
        ON "tariff_plans" ("kindergarten_id", "tariff_type")`,
    );

    await queryRunner.query(
      `ALTER TABLE "tariff_plans" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tariff_plans" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "tariff_plans"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. tariff_assignments ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "tariff_assignments" (
        "id"               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid          NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"         uuid          NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "tariff_plan_id"   uuid          NOT NULL REFERENCES "tariff_plans"("id") ON DELETE RESTRICT,
        "custom_amount"    numeric(12,2) CHECK ("custom_amount" >= 0),
        "custom_reason"    text,
        "valid_from"       date          NOT NULL,
        "valid_until"      date,
        "assigned_by"      uuid          NOT NULL REFERENCES "staff_members"("id") ON DELETE RESTRICT,
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_tariff_assignments_child_valid_from"
        ON "tariff_assignments" ("child_id", "valid_from")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tariff_assignments_kg_child"
        ON "tariff_assignments" ("kindergarten_id", "child_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tariff_assignments_tariff_plan_id"
        ON "tariff_assignments" ("tariff_plan_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "tariff_assignments" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tariff_assignments" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "tariff_assignments"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 4. payment_accounts ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "payment_accounts" (
        "id"               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid          NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"         uuid          NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "balance"          numeric(12,2) NOT NULL DEFAULT 0,
        "created_at"       timestamptz   NOT NULL DEFAULT now(),
        "updated_at"       timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "uq_payment_accounts_kg_child" UNIQUE ("kindergarten_id", "child_id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "payment_accounts" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_accounts" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "payment_accounts"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 5. invoices ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "invoices" (
        "id"                    uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"       uuid              NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"              uuid              NOT NULL REFERENCES "children"("id") ON DELETE RESTRICT,
        "payment_account_id"    uuid              NOT NULL REFERENCES "payment_accounts"("id") ON DELETE RESTRICT,
        "tariff_plan_id"        uuid              REFERENCES "tariff_plans"("id") ON DELETE SET NULL,
        "invoice_type"          "payment_type"    NOT NULL,
        "period_start"          date              NOT NULL,
        "period_end"            date              NOT NULL,
        "amount_due"            numeric(12,2)     NOT NULL CHECK ("amount_due" >= 0),
        "discount_pct"          numeric(5,2)      CHECK ("discount_pct" >= 0 AND "discount_pct" <= 100),
        "discount_reason"       text,
        "amount_after_discount" numeric(12,2)     NOT NULL CHECK ("amount_after_discount" >= 0),
        "status"                "payment_status"  NOT NULL DEFAULT 'pending',
        "due_date"              date              NOT NULL,
        "description"           text,
        "prorated_for_days"     smallint          CHECK ("prorated_for_days" >= 0),
        "created_at"            timestamptz       NOT NULL DEFAULT now(),
        "updated_at"            timestamptz       NOT NULL DEFAULT now(),
        CONSTRAINT "chk_invoices_period_end_gte_start"
          CHECK ("period_end" >= "period_start")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_invoices_child_id"
        ON "invoices" ("child_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_invoices_kg_due_date"
        ON "invoices" ("kindergarten_id", "due_date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_invoices_kg_status"
        ON "invoices" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_invoices_payment_account_id"
        ON "invoices" ("payment_account_id")`,
    );

    await queryRunner.query(`ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "invoices"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 6. invoice_line_items ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "invoice_line_items" (
        "id"               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
        "invoice_id"       uuid          NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
        "kindergarten_id"  uuid          NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "description"      text          NOT NULL,
        "tariff_plan_id"   uuid          REFERENCES "tariff_plans"("id") ON DELETE SET NULL,
        "quantity"         numeric(8,2)  NOT NULL DEFAULT 1 CHECK ("quantity" > 0),
        "unit_price"       numeric(12,2) NOT NULL CHECK ("unit_price" >= 0),
        "line_total"       numeric(12,2) NOT NULL CHECK ("line_total" >= 0),
        "created_at"       timestamptz   NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_invoice_line_items_invoice_id"
        ON "invoice_line_items" ("invoice_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "invoice_line_items" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_line_items" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "invoice_line_items"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 7. payments ───────────────────────────────────────────────────────────
    // NOTE: refund_id is nullable uuid with NO FK here — FK → refunds(id) is
    // added via ALTER TABLE after refunds table is created (circular reference).
    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"               uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid                NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "invoice_id"       uuid                NOT NULL REFERENCES "invoices"("id") ON DELETE RESTRICT,
        "child_id"         uuid                NOT NULL REFERENCES "children"("id") ON DELETE RESTRICT,
        "payer_user_id"    uuid                REFERENCES "users"("id") ON DELETE SET NULL,
        "amount"           numeric(12,2)       NOT NULL CHECK ("amount" > 0),
        "provider"         text                NOT NULL,
        "provider_txn_id"  text,
        "idempotency_key"  text                NOT NULL,
        "status"           "payment_status_v2" NOT NULL DEFAULT 'initiated',
        "provider_payload" jsonb,
        "paid_at"          timestamptz,
        "refund_id"        uuid,
        "created_at"       timestamptz         NOT NULL DEFAULT now(),
        "updated_at"       timestamptz         NOT NULL DEFAULT now(),
        CONSTRAINT "uq_payments_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "chk_payments_provider"
          CHECK ("provider" IN ('mock', 'halyk_epay', 'kaspi_pay', 'tiptoppay', 'freedom_pay', 'cash'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_payments_provider_txn_id"
        ON "payments" ("provider", "provider_txn_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_kg_status"
        ON "payments" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_invoice_id"
        ON "payments" ("invoice_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_child_id"
        ON "payments" ("child_id")`,
    );

    await queryRunner.query(`ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "payments" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "payments"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 8. refunds ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "refunds" (
        "id"               uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid             NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "payment_id"       uuid             NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT,
        "invoice_id"       uuid             REFERENCES "invoices"("id") ON DELETE SET NULL,
        "amount"           numeric(12,2)    NOT NULL CHECK ("amount" > 0),
        "reason"           text             NOT NULL,
        "status"           "refund_status"  NOT NULL DEFAULT 'pending',
        "processed_by"     uuid             REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "provider_ref"     text,
        "created_at"       timestamptz      NOT NULL DEFAULT now(),
        "updated_at"       timestamptz      NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_refunds_payment_id"
        ON "refunds" ("payment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refunds_kg_status"
        ON "refunds" ("kindergarten_id", "status")`,
    );

    await queryRunner.query(`ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "refunds"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 9. payments.refund_id FK (circular — added after refunds exists) ──────
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "fk_payments_refund_id"
        FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL
    `);

    // ── 10. kindergarten_holidays ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "kindergarten_holidays" (
        "id"               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"  uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "date"             date        NOT NULL,
        "name"             jsonb       NOT NULL,
        "is_billable"      boolean     NOT NULL DEFAULT false,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_kindergarten_holidays_kg_date" UNIQUE ("kindergarten_id", "date")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "kindergarten_holidays" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "kindergarten_holidays" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "kindergarten_holidays"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 11. REVOKE TRUNCATE (defence-in-depth per db8cb72 pattern) ─────────────
    await queryRunner.query(
      `REVOKE TRUNCATE ON "tariff_plans", "tariff_assignments", "payment_accounts", "invoices", "invoice_line_items", "payments", "refunds", "kindergarten_holidays" FROM "shyraq_app"`,
    );

    // ── 12. FK ALTER: parent_requests.invoice_id → invoices(id) (B12 leftover) ─
    // Column parent_requests.invoice_id was created in B12 as a plain uuid
    // with no FK (invoices table didn't exist yet). Now that invoices exists,
    // we add the FK constraint.
    await queryRunner.query(`
      ALTER TABLE "parent_requests"
        ADD CONSTRAINT "fk_parent_requests_invoice_id"
        FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse FK-dependency order.
    // B12 FK first (references invoices)
    await queryRunner.query(`
      ALTER TABLE "parent_requests"
        DROP CONSTRAINT IF EXISTS "fk_parent_requests_invoice_id"
    `);

    // payments.refund_id circular FK
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT IF EXISTS "fk_payments_refund_id"
    `);

    // kindergarten_holidays
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "kindergarten_holidays"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "kindergarten_holidays" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "kindergarten_holidays" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "kindergarten_holidays"`);

    // refunds
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "refunds"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "refunds" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "refunds" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_refunds_kg_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_refunds_payment_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refunds"`);

    // payments
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "payments"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "payments" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "payments" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_child_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_invoice_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_payments_kg_status"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payments_provider_txn_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);

    // invoice_line_items
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "invoice_line_items"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "invoice_line_items" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "invoice_line_items" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_invoice_line_items_invoice_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "invoice_line_items"`);

    // invoices
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "invoices"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "invoices" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "invoices" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_invoices_payment_account_id"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_kg_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_kg_due_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_invoices_child_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "invoices"`);

    // payment_accounts
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "payment_accounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "payment_accounts" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "payment_accounts" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_accounts"`);

    // tariff_assignments
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "tariff_assignments"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "tariff_assignments" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "tariff_assignments" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_tariff_assignments_tariff_plan_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_tariff_assignments_kg_child"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_tariff_assignments_child_valid_from"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "tariff_assignments"`);

    // tariff_plans
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "tariff_plans"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "tariff_plans" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "tariff_plans" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_tariff_plans_kg_tariff_type"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_tariff_plans_kg_is_active"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "tariff_plans"`);

    // ENUMs (after all referencing tables are dropped)
    await queryRunner.query(`DROP TYPE IF EXISTS "refund_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_status_v2"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payment_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tariff_applies_to"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "tariff_type"`);
  }
}
