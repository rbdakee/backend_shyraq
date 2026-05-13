import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22b T12 — Partial indexes supporting the weekly outbox-prune job.
 *
 * `OutboxPruneProcessor` runs every Sunday 04:00 Asia/Almaty and deletes
 * terminal `notification_outbox` rows past their retention horizon:
 *
 *   DELETE FROM notification_outbox
 *    WHERE status = 'dispatched' AND created_at < $1   -- now - 7d
 *
 *   DELETE FROM notification_outbox
 *    WHERE status = 'failed' AND created_at < $1       -- now - 30d
 *
 * The B9 partial index `idx_outbox_pending` is gated on `status='pending'`
 * so it cannot serve either DELETE. Without these indexes the prune
 * planner falls back to a Seq Scan of the entire outbox table — fine in
 * the small but degrades badly once the retention window saturates.
 *
 * Two narrow partial indexes (one per terminal status) over `created_at`
 * let PG produce an index-only scan of exactly the rows being deleted.
 * They share the `notification_outbox` page chain so writes pay only one
 * matching index lookup per terminal transition (dispatched-write or
 * failed-write — never both).
 *
 * Idempotent via `CREATE INDEX IF NOT EXISTS`; the index name encodes
 * status so the two coexist without collision.
 */
export class B22OutboxPruneIndex1778650000000 implements MigrationInterface {
  name = 'B22OutboxPruneIndex1778650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_dispatched_created_at"
        ON "notification_outbox" ("created_at")
        WHERE "status" = 'dispatched'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_failed_created_at"
        ON "notification_outbox" ("created_at")
        WHERE "status" = 'failed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_outbox_failed_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_outbox_dispatched_created_at"`,
    );
  }
}
