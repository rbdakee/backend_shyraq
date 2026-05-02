import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B9 review HIGH#3 — make `push_tokens` globally unique by `(platform, token)`.
 *
 * Pre-fix model: UNIQUE was on `(user_id, token)`. That allowed two rows
 * with the same FCM/APNs token but different `user_id` to coexist — so a
 * shared physical device whose token persisted across user-switches could
 * receive notifications addressed to the previous owner. The dispatcher
 * fans out by `user_id`, so push for user A would reach the device after
 * user B took it over (and vice-versa).
 *
 * Post-fix model:
 *   - UNIQUE `(platform, token)` (industry standard — FCM/APNs/web are
 *     namespaced per platform, so colliding token strings across platforms
 *     are not assumed unique).
 *   - Plain INDEX on `user_id` is kept for the dispatcher's per-user fan-out
 *     query (`findByUserIds`). The previous UNIQUE on `(user_id, token)` was
 *     ALSO providing the user_id index implicitly — we replace it with an
 *     explicit non-unique index.
 *
 * Cleanup BEFORE creating the unique index — if any duplicate
 * `(platform, token)` groups exist (legacy rows from before this migration),
 * keep only the row with the most recent `last_seen_at`. Older duplicates
 * are deleted (their owner is the most likely stale one).
 *
 * `down()`: reverse — drop `(platform, token)` unique + restore
 * `(user_id, token)` unique. Down does NOT restore deleted dupes — that's
 * intentional; the dedup is one-way.
 */
export class B9PushTokenPlatformUnique1777684557517 implements MigrationInterface {
  name = 'B9PushTokenPlatformUnique1777684557517';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Dedup: keep the row with MAX(last_seen_at, created_at) per
    //    (platform, token) group; delete the rest.
    await queryRunner.query(`
      DELETE FROM "push_tokens"
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id",
                 ROW_NUMBER() OVER (
                   PARTITION BY "platform", "token"
                   ORDER BY "last_seen_at" DESC, "created_at" DESC
                 ) AS rn
          FROM "push_tokens"
        ) ranked
        WHERE rn > 1
      )
    `);

    // 2. Drop the old (user_id, token) unique. Keeping the user_id index
    //    means we still need a non-unique replacement for the user_id
    //    dispatcher fan-out query.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_push_tokens_user_token"`,
    );

    // 3. Create the new (platform, token) unique.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_push_tokens_platform_token"
        ON "push_tokens" ("platform", "token")
    `);

    // 4. The (user_id) plain index from the original migration already
    //    exists; no action needed. (idx_push_tokens_user_id)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse: drop new unique, restore old (user_id, token) unique.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_push_tokens_platform_token"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_push_tokens_user_token"
        ON "push_tokens" ("user_id", "token")
    `);
  }
}
