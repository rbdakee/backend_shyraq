import { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleIdent } from '../app-role.util';

/**
 * B12 — Parent Requests (BP §6).
 *
 * Creates two tenant-scoped tables:
 *   1. parent_requests       — 5-type request (trusted_person, day_off, vacation,
 *                              late_pickup, open_request) with state machine
 *                              pending → {accepted, rejected, cancelled}
 *   2. parent_request_messages — bidirectional thread; exactly one of
 *                              author_user_id / author_staff_id populated (CHECK XOR).
 *
 * New ENUMs:
 *   - parent_request_type    — trusted_person | day_off | vacation | late_pickup | open_request
 *   - parent_request_status  — pending | accepted | rejected | cancelled
 *
 * NOTE on invoice_id:
 *   Stored as plain uuid with NO FK — the `invoices` table is created in B13.
 *   B13 will add the FK constraint via ALTER TABLE.
 *
 * NOTE on pickup_requests.parent_request_id FK:
 *   B11 left parent_request_id as a plain uuid column (no FK) on pickup_requests.
 *   This migration does NOT add that FK — it is deferred to a later cleanup migration
 *   once the column exists on both sides (parent_requests.id is available now).
 *
 * RLS pattern identical to B11 (tenant_isolation policy):
 *   ENABLE + FORCE ROW LEVEL SECURITY; coalesce(bypass_rls) OR kindergarten_id = setting::uuid.
 *
 * REVOKE TRUNCATE: runtime role (shyraq_app) must not be able to TRUNCATE tenant tables
 *   (ALTER DEFAULT PRIVILEGES in InitExtensions + RevokeTruncate migrations already cover
 *   future tables, but the explicit per-table REVOKE is added as defence-in-depth per
 *   the pattern established in db8cb72).
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions.
 */
export class B12ParentRequests1777800001000 implements MigrationInterface {
  name = 'B12ParentRequests1777800001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. ENUMs ──────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE "parent_request_type" AS ENUM (
        'trusted_person',
        'day_off',
        'vacation',
        'late_pickup',
        'open_request'
      )
    `);

    await queryRunner.query(`
      CREATE TYPE "parent_request_status" AS ENUM (
        'pending',
        'accepted',
        'rejected',
        'cancelled'
      )
    `);

    // ── 2. parent_requests ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "parent_requests" (
        "id"                  uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"     uuid                    NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"            uuid                    NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "requester_user_id"   uuid                    NOT NULL REFERENCES "users"("id"),
        "request_type"        "parent_request_type"   NOT NULL,
        "status"              "parent_request_status" NOT NULL DEFAULT 'pending',
        "date_from"           date,
        "date_to"             date,
        "details"             jsonb                   NOT NULL DEFAULT '{}',
        "recipient_type"      varchar(20),
        "recipient_staff_id"  uuid                    REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "reviewed_by"         uuid                    REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "reviewed_at"         timestamptz,
        "review_note"         text,
        "invoice_id"          uuid,
        "created_at"          timestamptz             NOT NULL DEFAULT now(),
        "updated_at"          timestamptz             NOT NULL DEFAULT now()
      )
    `);

    // ── 3. Indexes for parent_requests ────────────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX "idx_parent_requests_kg_status"
        ON "parent_requests" ("kindergarten_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_parent_requests_child_created"
        ON "parent_requests" ("child_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_parent_requests_recipient_staff_status"
        ON "parent_requests" ("recipient_staff_id", "status")
        WHERE "recipient_staff_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_parent_requests_requester_created"
        ON "parent_requests" ("requester_user_id", "created_at" DESC)`,
    );

    // ── 4. RLS for parent_requests ────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "parent_requests" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "parent_requests" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "parent_requests"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 5. parent_request_messages ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "parent_request_messages" (
        "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"     uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "parent_request_id"   uuid        NOT NULL REFERENCES "parent_requests"("id") ON DELETE CASCADE,
        "author_user_id"      uuid        REFERENCES "users"("id") ON DELETE SET NULL,
        "author_staff_id"     uuid        REFERENCES "staff_members"("id") ON DELETE SET NULL,
        "body"                text        NOT NULL,
        "attachments"         text[],
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_parent_request_messages_author_xor"
          CHECK (
            (("author_user_id" IS NOT NULL)::int + ("author_staff_id" IS NOT NULL)::int) = 1
          )
      )
    `);

    // ── 6. Indexes for parent_request_messages ────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX "idx_parent_request_messages_request_created"
        ON "parent_request_messages" ("parent_request_id", "created_at" ASC)`,
    );

    // ── 7. RLS for parent_request_messages ────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "parent_request_messages" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "parent_request_messages" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "parent_request_messages"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 8. REVOKE TRUNCATE (defence-in-depth per db8cb72 pattern) ─────────────
    // ALTER DEFAULT PRIVILEGES in RevokeTruncateFromAppRole migration already
    // covers future tables, but explicit per-table revoke adds a hard guarantee.
    await queryRunner.query(
      `REVOKE TRUNCATE ON "parent_requests", "parent_request_messages" FROM ${appRoleIdent()}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse order: messages → requests → ENUMs

    // parent_request_messages
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "parent_request_messages"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "parent_request_messages" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "parent_request_messages" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_parent_request_messages_request_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "parent_request_messages"`);

    // parent_requests
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "parent_requests"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "parent_requests" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "parent_requests" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_parent_requests_requester_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_parent_requests_recipient_staff_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_parent_requests_child_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_parent_requests_kg_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "parent_requests"`);

    // ENUMs (after tables that reference them are dropped)
    await queryRunner.query(`DROP TYPE IF EXISTS "parent_request_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "parent_request_type"`);
  }
}
