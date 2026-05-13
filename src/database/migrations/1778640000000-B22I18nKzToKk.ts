import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B22b T1 — i18n key sweep: `kz` → `kk` data migration.
 *
 * Background: the codebase carried a long-standing inconsistency between
 * the country-code TLD `kz` (used by billing/content/holiday DTOs and the
 * birthday template builder) and the BCP-47 language code `kk` (used by
 * the notification dispatcher and most newer code). `kk` is the correct
 * ISO standard. B22b T1 standardises on `kk` everywhere on the write
 * path; this migration upgrades existing JSONB rows so reads return the
 * canonical key as the primary value.
 *
 * For every tenant-scoped JSONB column that may carry an i18n locale map:
 *   1. If the row has `kz` but NOT `kk`, copy the value across to `kk`
 *      and strip the `kz` key.
 *   2. If the row has BOTH `kz` and `kk`, the explicit `kk` wins —
 *      drop the legacy `kz` key. This matches the new read-side
 *      precedence (`kk ?? kz`) in `pickName` / dispatcher templates.
 *
 * The migration is idempotent and safe to re-run: rows that never had
 * `kz` are untouched, and the second pass is a no-op once `kz` is gone.
 *
 * Down: empty by design. Reverting would re-introduce the inconsistency
 * the migration was created to remove; legacy `kz` keys can still be
 * read for one release via the dispatcher / content fallback helpers.
 *
 * Migration timestamp `1778640000000` — strictly greater than the last
 * B22a migration (`1778633200000-B22ChildStatusHistoryFkFix`).
 */
export class B22I18nKzToKk1778640000000 implements MigrationInterface {
  name = 'B22I18nKzToKk1778640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // (table, column) pairs verified by reading the CREATE TABLE source
    // in each B-batch migration. Only columns that actually exist and
    // may carry i18n locale maps are touched. Empty tables / rows
    // without `kz` are no-ops thanks to the `WHERE col ? 'kz'` guard.
    const targets: Array<[table: string, column: string]> = [
      // B9 — push notifications
      ['notifications', 'title_i18n'],
      ['notifications', 'body_i18n'],

      // B13 — billing
      ['tariff_plans', 'description'],
      ['kindergarten_holidays', 'name'],

      // B16 — custom discounts
      ['custom_discounts', 'name'],
      ['custom_discounts', 'description'],
      ['custom_discounts', 'notification_title'],
      ['custom_discounts', 'notification_body'],

      // B17 — content & stories
      ['content_posts', 'title_i18n'],
      ['content_posts', 'body_i18n'],

      // B7 — meal plan dish names (already `kk` in code, but
      // historical rows may carry `kz`; harmless if none exist).
      // Table is named `meal_items` (FK → `meal_plans.id`), not
      // `meal_plan_items` — see `1777593606000-B7ScheduleAndMeal.ts`.
      ['meal_items', 'dish_name'],
      ['meal_items', 'description'],
    ];

    for (const [table, column] of targets) {
      // Step 1: rows that have `kz` but not `kk` — move the value to `kk`.
      await queryRunner.query(
        `UPDATE "${table}"
            SET "${column}" = jsonb_set("${column}" - 'kz', '{kk}', "${column}"->'kz')
          WHERE "${column}" IS NOT NULL
            AND "${column}" ? 'kz'
            AND NOT ("${column}" ? 'kk')`,
      );

      // Step 2: rows that have BOTH `kz` and `kk` — drop the legacy `kz`
      // key, keeping the explicit `kk` value.
      await queryRunner.query(
        `UPDATE "${table}"
            SET "${column}" = "${column}" - 'kz'
          WHERE "${column}" IS NOT NULL
            AND "${column}" ? 'kz'
            AND "${column}" ? 'kk'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Intentional no-op. This is a data migration that fixes a
    // taxonomy mistake (`kz` country-code TLD where BCP-47 `kk` was
    // meant). Reverting would re-introduce the inconsistency, and the
    // read-side fallback in pickName / dispatcher templates still
    // tolerates `kz` for one release so external integrations have a
    // window to migrate. The fallback is scheduled for removal in B23.
  }
}
