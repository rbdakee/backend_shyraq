import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B24 follow-up — idempotently (re)seed the singleton `kaspi_global_config`
 * row (id = 1).
 *
 * Why this exists: the original `B24KaspiPay` migration both CREATES the table
 * and seeds the id=1 row in one `up()`. On any database where that migration
 * was recorded as run BEFORE the seed INSERT was finalized (e.g. a dev DB the
 * migration was iterated against during development), TypeORM never re-runs it —
 * so the table exists but is EMPTY. An empty `kaspi_global_config` breaks every
 * Kaspi call (`KaspiGlobalConfigService.getConfig()` finds no row).
 *
 * This is a NEW migration, so it runs exactly once on EVERY database regardless
 * of B24's prior state. `ON CONFLICT (id) DO NOTHING` makes it safe: it fills
 * the row when missing and is a no-op when the row already exists (never
 * overwrites an admin-tuned `app_build`).
 *
 * Values are identical to the B24KaspiPay seed (live values from
 * kaspi_pay_test/src/config.js).
 */
export class B24KaspiGlobalConfigReseed1778690000000 implements MigrationInterface {
  name = 'B24KaspiGlobalConfigReseed1778690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "kaspi_global_config"
        (id, app_version, app_build, platform_ver, model, brand,
         ua_native, ua_browser, entrance_url, mtoken_url, qrpay_url, updated_by)
      VALUES
        (1, '4.110.1', '1076', '18.5', 'iPhone17,3', 'Apple',
         'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
         'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
         'https://entrance-pay.kaspi.kz',
         'https://mtoken.kaspi.kz',
         'https://qrpay.kaspi.kz',
         NULL)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    // Intentional no-op: the row's lifecycle belongs to B24KaspiPay (whose
    // down() drops the whole table). Deleting it here would wrongly remove a
    // row this migration may not have created.
  }
}
