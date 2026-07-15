import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activity event origin — durable provenance marker. Follow-up to B7.
 *
 * Problem: `activity_events.template_slot_id` references
 * `schedule_template_slots(id)` ON DELETE SET NULL (B7ScheduleAndMeal). When an
 * admin edits a template, ScheduleTemplateRelationalRepository.save() DELETEs
 * the slots that are no longer in the desired set, which silently NULLs
 * `template_slot_id` on every already-materialized event projected from them.
 * Those events survive as orphans carrying stale names, and become
 * indistinguishable from genuine ad-hoc events — which also have
 * `template_slot_id IS NULL`. The FK alone therefore cannot answer "where did
 * this event come from?".
 *
 * Fix: `origin` is written once at creation (never updated) and is not an FK,
 * so no cascade can erase it. It stays authoritative after the slot is gone.
 *
 * Column shape: varchar(20) + CHECK rather than a PG ENUM. The vocabulary is
 * closed and provenance is a write-once flag, so the ENUM's main benefit
 * (cheap ALTER TYPE ... ADD VALUE) buys nothing, while CHECK stays trivially
 * revertible. Matches the existing varchar-with-small-vocabulary precedent in
 * B7 (`schedule_templates.recurrence`, `schedule_week_snapshots.source`).
 *
 * Backfill: rows with a live `template_slot_id` are provably 'template'; the
 * rest take 'adhoc'.
 *
 * KNOWN LIMITATION — rows already orphaned by a prior slot-delete (i.e.
 * projected from a template, but whose slot was deleted before this migration
 * ran) are backfilled as 'adhoc'. Their true provenance is unrecoverable: the
 * SET NULL destroyed the only link, and nothing else in the schema records it.
 * We do NOT guess from `activity_name` / snapshot proximity — a heuristic would
 * mislabel rows while looking authoritative, which is worse than a known-wrong
 * uniform value. These pre-existing orphans are cleaned up separately as a
 * one-off data repair; from this migration forward the marker is exact.
 *
 * RLS: `activity_events` already has ENABLE + FORCE ROW LEVEL SECURITY and the
 * `tenant_isolation` policy from B7. Adding a column needs no policy change —
 * deliberately not re-declared here. The backfill UPDATE below runs under the
 * migration role (superuser, RLS-exempt) and so correctly spans all tenants.
 *
 * Additive & backward-compatible: NOT NULL DEFAULT 'template' means existing
 * writers that don't send `origin` keep working.
 */
export class ActivityEventOrigin1784300000000 implements MigrationInterface {
  name = 'ActivityEventOrigin1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "activity_events"
        ADD COLUMN "origin" varchar(20) NOT NULL DEFAULT 'template'
    `);

    await queryRunner.query(`
      ALTER TABLE "activity_events"
        ADD CONSTRAINT "chk_activity_events_origin"
        CHECK ("origin" IN ('template', 'adhoc'))
    `);

    // Backfill. The ADD COLUMN default already stamped every existing row
    // 'template', so only the ad-hoc side needs a pass. Events with a live slot
    // FK keep 'template'; everything else is either a true ad-hoc event or a
    // pre-existing orphan (see KNOWN LIMITATION above) — both land on 'adhoc'.
    await queryRunner.query(`
      UPDATE "activity_events"
        SET "origin" = 'adhoc'
        WHERE "template_slot_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "activity_events"
        DROP CONSTRAINT IF EXISTS "chk_activity_events_origin"
    `);
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "activity_events"
        DROP COLUMN IF EXISTS "origin"
    `);
  }
}
