import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22a T13 M2 (codex) — `child_status_history` composite FK fix.
 *
 * The original B22 migration (`1778633100000-B22ChildStatusHistory.ts`)
 * declared a single-column FK `child_id REFERENCES children(id) ON DELETE
 * CASCADE`, plus a separate `kindergarten_id REFERENCES kindergartens(id)`.
 * Service code always builds both columns from the same request, but the
 * DB allowed an impossible audit row where `child_status_history.
 * kindergarten_id = kg_A` referenced a child living in `kg_B`. RLS
 * exposes rows by `child_status_history.kindergarten_id`, so a future
 * bug or manual repair could leak a tenant_B child UUID into a tenant_A
 * audit report.
 *
 * Fix: add a composite UNIQUE `(id, kindergarten_id)` on `children` so it
 * can serve as a composite FK target, then replace the single-col FK on
 * `child_status_history.child_id` with a composite FK
 * `(child_id, kindergarten_id) REFERENCES children(id, kindergarten_id)
 *  ON DELETE CASCADE`. The composite FK fails fast on tenant-mismatch
 * INSERTs at the DB boundary even if the service layer regresses.
 *
 * Mirrors the B13 FK-fix migration pattern (drop + re-add with
 * `IF EXISTS`), and is independently reversible via `down()`.
 *
 * Migration timestamp `1778633200000` — strictly greater than the B22
 * T9 migration (`1778633100000`) so the FK fix lands AFTER the audit
 * table exists.
 */
export class B22ChildStatusHistoryFkFix1778633200000 implements MigrationInterface {
  name = 'B22ChildStatusHistoryFkFix1778633200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. composite UNIQUE on children(id, kindergarten_id) ──────────────
    // `id` is already PRIMARY KEY (so unique on its own); we add the
    // composite `(id, kindergarten_id)` purely so PG accepts it as a
    // composite FK target. The constraint never rejects an INSERT/UPDATE
    // that would have passed the PK check.
    await queryRunner.query(
      `ALTER TABLE "children"
         ADD CONSTRAINT "uq_children_id_kg" UNIQUE ("id", "kindergarten_id")`,
    );

    // ── 2. drop the single-column FK on child_status_history.child_id ─────
    // TypeORM auto-generated the constraint name in the B22 T9 migration
    // — convention is `<table>_<column>_fkey`. `IF EXISTS` keeps the
    // migration safe across environments where the constraint name may
    // diverge.
    await queryRunner.query(
      `ALTER TABLE "child_status_history"
         DROP CONSTRAINT IF EXISTS "child_status_history_child_id_fkey"`,
    );

    // ── 3. add composite FK (child_id, kindergarten_id) → children ────────
    await queryRunner.query(
      `ALTER TABLE "child_status_history"
         ADD CONSTRAINT "child_status_history_child_kg_fkey"
         FOREIGN KEY ("child_id", "kindergarten_id")
         REFERENCES "children"("id", "kindergarten_id")
         ON DELETE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original (loose) FK shape so the migration is
    // reversible in dev / staging.
    await queryRunner.query(
      `ALTER TABLE "child_status_history"
         DROP CONSTRAINT IF EXISTS "child_status_history_child_kg_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "child_status_history"
         ADD CONSTRAINT "child_status_history_child_id_fkey"
         FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "children"
         DROP CONSTRAINT IF EXISTS "uq_children_id_kg"`,
    );
  }
}
