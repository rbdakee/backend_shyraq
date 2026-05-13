import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22a T7 — Admin-bypass-on-PATCH audit columns for the two diagnostics
 * mutation surfaces.
 *
 * Closes B18 Concern 1 (admin override on `diagnostic_entries` /
 * `progress_notes` was invisible in the DB — admin spoofs the entry's
 * `specialist_id` / note's `mentor_id` at the controller layer to bypass
 * `assertAuthoredBy`, so without an external audit trail there is no way
 * to tell who actually edited the row).
 *
 * Each table grows two nullable columns:
 *   - `last_modified_by_user_id uuid REFERENCES users(id)` — populated
 *     with `req.user.sub` (caller's `users.id`) on every PATCH; nullable
 *     so historical rows backfill cleanly.
 *   - `last_modified_at timestamptz` — populated with `clock.now()` on
 *     every PATCH; nullable for the same backfill reason.
 *
 * FK target is `users(id)` (NOT `staff_members(id)`) — same convention as
 * B13 `tariff_assignments.assigned_by` / `refunds.processed_by` after the
 * B13 FK fix. Admin overrides are tracked at the user level so we can
 * follow the audit trail across staff_member churn (terminate + re-add
 * in a different role would break a staff_member-FK link).
 *
 * `ON DELETE SET NULL` would be the natural choice for `users` deletes,
 * but Shyraq today never hard-deletes a user row (`users.is_active=false`
 * soft-delete only) — we omit the ON DELETE clause so the FK defaults to
 * NO ACTION; deletes will fail loudly if anyone tries them.
 *
 * The columns are NOT exposed via DTO in B22a — the audit trail lives in
 * the DB only (matches the doc framing in `docs/Shyraq BP.md` §11.1 and
 * `docs/endpoints.md` §3.10/§3.11). A future task can wire a dedicated
 * admin endpoint that surfaces them once compliance/UX requirements are
 * formalised.
 */
export class B22DiagnosticAuditColumns1778633000000 implements MigrationInterface {
  name = 'B22DiagnosticAuditColumns1778633000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `IF NOT EXISTS` keeps the migration idempotent under accidental
    // re-runs. Both ALTERs are nullable + no DEFAULT, so PG's fast-path
    // applies (no table rewrite even on large tables).
    await queryRunner.query(`
      ALTER TABLE "diagnostic_entries"
        ADD COLUMN IF NOT EXISTS "last_modified_by_user_id" uuid
          REFERENCES "users"("id"),
        ADD COLUMN IF NOT EXISTS "last_modified_at" timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE "progress_notes"
        ADD COLUMN IF NOT EXISTS "last_modified_by_user_id" uuid
          REFERENCES "users"("id"),
        ADD COLUMN IF NOT EXISTS "last_modified_at" timestamptz
    `);

    // Column comments document the intent so DB-side readers (psql, DBA
    // tools) discover the audit purpose without hopping to the
    // migration source. Comments are zero-cost metadata on PG.
    await queryRunner.query(`
      COMMENT ON COLUMN "diagnostic_entries"."last_modified_by_user_id" IS
        'B22a T7 — users.id of last PATCH caller (incl. admin override); NULL for never-modified rows'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "diagnostic_entries"."last_modified_at" IS
        'B22a T7 — timestamp of last PATCH (clock.now); NULL for never-modified rows'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "progress_notes"."last_modified_by_user_id" IS
        'B22a T7 — users.id of last PATCH caller (incl. admin override); NULL for never-modified rows'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "progress_notes"."last_modified_at" IS
        'B22a T7 — timestamp of last PATCH (clock.now); NULL for never-modified rows'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "progress_notes" DROP COLUMN IF EXISTS "last_modified_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "progress_notes" DROP COLUMN IF EXISTS "last_modified_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "diagnostic_entries" DROP COLUMN IF EXISTS "last_modified_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "diagnostic_entries" DROP COLUMN IF EXISTS "last_modified_by_user_id"`,
    );
  }
}
