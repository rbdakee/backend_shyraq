import { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleIdent } from '../app-role.util';

/**
 * B22a T9 — `child_status_history` audit table.
 *
 * Closes B21 T6-L1 / T6-M4 / T7-L1 — the carry-forward "no per-actor audit
 * for archive/reactivate transitions" gap. Every change of `children.status`
 * is now recorded as an append-only row written atomically inside the same
 * ambient TX as the conditional status UPDATE (so a failed history INSERT
 * rolls the status flip back).
 *
 * Schema notes:
 *
 *  - `changed_by_user_id` references `users(id)` (NOT `staff_members(id)`).
 *    Same convention as B13's `tariff_assignments.assigned_by` and
 *    `refunds.processed_by` after the B13 FK fix — controllers write
 *    `req.user.sub` directly (admin overrides survive staff_member churn:
 *    terminate + re-add in a different role would otherwise break a
 *    staff_member-FK link). `ON DELETE` is omitted (defaults to NO
 *    ACTION) — Shyraq today never hard-deletes `users` rows
 *    (`is_active=false` soft-delete only) and we want the FK to fail
 *    loudly if anyone tries.
 *
 *  - `chk_valid_transition` enumerates the only allowed transitions:
 *      `active → archived`, `archived → active`, `card_created → active`.
 *    The domain (`Child.archive` / `Child.reactivate` / `Child.activate`)
 *    already enforces these — the CHECK is defense-in-depth so a stray
 *    direct INSERT (CLI scripts, future code paths) cannot record an
 *    impossible transition.
 *
 *  - `chk_archive_reason_on_archive` mirrors the P5 invariant: every
 *    `new_status='archived'` row MUST carry an `archive_reason`. The
 *    domain already validates this (`ArchiveReasonRequiredError`) — CHECK
 *    catches any future regression at the DB boundary.
 *
 *  - RLS: `tenant_isolation` policy + FORCE ROW LEVEL SECURITY (FORCE so
 *    even the table owner role observes the policy in tests). Bypass is
 *    via `app.bypass_rls=true` for super-admin paths, mirroring the rest
 *    of the children/* family.
 *
 *  - REVOKE TRUNCATE — already covered globally by
 *    `RevokeTruncateFromAppRole` migration which sets default privileges
 *    on `public` so new tables created here inherit a TRUNCATE-less ACL
 *    for `shyraq_app`. We add an explicit REVOKE here too as a safety
 *    net (idempotent) and to make the intent visible to anyone reading
 *    only this migration file.
 *
 *  - Indexes:
 *      `idx_child_status_history_kg_changed_at (kindergarten_id,
 *      changed_at DESC)` — admin "recent activity" reads (kg-wide).
 *      `idx_child_status_history_child (child_id, changed_at DESC)` —
 *      the per-child GET endpoint (`/admin/children/:id/status-history`).
 *
 * `created_at` is separate from `changed_at` so `changed_at` carries the
 * actor-supplied timestamp (i.e. `clock.now()` at the service layer)
 * while `created_at` records the DB-side insert moment for forensic
 * cross-checks.
 */
export class B22ChildStatusHistory1778633100000 implements MigrationInterface {
  name = 'B22ChildStatusHistory1778633100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "child_status_history" (
        "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"          uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "child_id"                 uuid NOT NULL REFERENCES "children"("id") ON DELETE CASCADE,
        "previous_status"          varchar(32) NOT NULL,
        "new_status"               varchar(32) NOT NULL,
        "previous_archive_reason"  text,
        "archive_reason"           text,
        "changed_by_user_id"       uuid NOT NULL REFERENCES "users"("id"),
        "changed_at"               timestamptz NOT NULL,
        "created_at"               timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_valid_transition" CHECK (
          (previous_status = 'active'        AND new_status = 'archived')
          OR (previous_status = 'archived'   AND new_status = 'active')
          OR (previous_status = 'card_created' AND new_status = 'active')
        ),
        CONSTRAINT "chk_archive_reason_on_archive" CHECK (
          new_status <> 'archived' OR archive_reason IS NOT NULL
        )
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_child_status_history_kg_changed_at" ON "child_status_history" ("kindergarten_id", "changed_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_child_status_history_child" ON "child_status_history" ("child_id", "changed_at" DESC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "child_status_history" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "child_status_history" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY "tenant_isolation" ON "child_status_history"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // Defence-in-depth: even though `RevokeTruncateFromAppRole` removes
    // TRUNCATE from the default privilege set for new tables, we revoke
    // again here so the intent is visible in this migration file too.
    // `IF EXISTS` would not apply here — REVOKE is silently no-op when
    // the privilege was never granted.
    await queryRunner.query(
      `REVOKE TRUNCATE ON "child_status_history" FROM ${appRoleIdent()}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS "tenant_isolation" ON "child_status_history"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_status_history" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "child_status_history" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_child_status_history_child"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_child_status_history_kg_changed_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "child_status_history"`);
  }
}
