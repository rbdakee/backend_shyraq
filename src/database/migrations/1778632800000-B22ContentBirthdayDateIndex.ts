import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22a T2 — Partial functional index for the birthday idempotency lookup.
 *
 * `ContentPostRelationalRepository.existsBirthdayForChildOnDate` runs:
 *
 *   SELECT 1 FROM content_posts
 *    WHERE kindergarten_id = $1
 *      AND content_type = 'birthday'
 *      AND target_child_id = $2
 *      AND DATE(published_at AT TIME ZONE 'Asia/Almaty') = $3::date
 *    LIMIT 1
 *
 * The predicate `AT TIME ZONE 'Asia/Almaty'` is STABLE (not IMMUTABLE) so
 * PostgreSQL cannot use plain `idx_content_posts_kg_published_at` for this
 * lookup — every birthday-cron tick degrades to a partial seq-scan of the
 * tenant's content_posts. With ~365 posts/year/child and N children per kg
 * this is fine today, but it scales badly.
 *
 * Fix (B17 MEDIUM#11): add a partial **functional** index over the same
 * expression the WHERE clause uses. PG can match the predicate verbatim
 * and serve the lookup index-only. We keep the index narrow with
 * `WHERE content_type = 'birthday'` so it costs nothing for the other
 * content types (news/menu/schedule_pub/qundylyq).
 *
 * Generated columns were rejected: they alter the table schema, the
 * value would be redundant (already derivable from `published_at`), and
 * `STORED` would inflate the row by 4 bytes per row.
 */
export class B22ContentBirthdayDateIndex1778632800000 implements MigrationInterface {
  name = 'B22ContentBirthdayDateIndex1778632800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotent — `CREATE INDEX IF NOT EXISTS` is safe under re-run and
    // does not block existing connections (no CONCURRENTLY needed at this
    // table size; promote to CONCURRENTLY when content_posts grows large).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_content_posts_birthday_date_almaty"
        ON "content_posts"
           ("kindergarten_id",
            "target_child_id",
            (DATE(published_at AT TIME ZONE 'Asia/Almaty')))
        WHERE "content_type" = 'birthday'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_content_posts_birthday_date_almaty"`,
    );
  }
}
