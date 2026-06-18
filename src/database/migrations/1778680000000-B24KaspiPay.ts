import { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleIdent } from '../app-role.util';

/**
 * B24 — Kaspi Pay integration tables.
 *
 * Creates two tables:
 *
 * 1. `kaspi_merchant_session` (TENANT-SCOPED, FORCE RLS)
 *    One row per kindergarten — a single Kaspi cashier session bound to that
 *    tenant.  All sensitive credential fields are encrypted at-rest with
 *    AES-256-GCM via CryptoCipherAdapter (key: env KASPI_ENCRYPTION_KEY).
 *    Backed by PG ENUM `kaspi_session_status` (pending → active → expired | revoked).
 *    UNIQUE(kindergarten_id) ensures one cashier account per kindergarten.
 *    RLS: tenant_isolation policy + FORCE ROW LEVEL SECURITY, mirroring the
 *    rest of the tenant-scoped table family.
 *    REVOKE TRUNCATE from shyraq_app (safety-net, mirrors B22+).
 *
 * 2. `kaspi_global_config` (GLOBAL, NO RLS, single-row guard)
 *    One row (id = 1, enforced by CHECK chk_kaspi_global_config_singleton).
 *    Holds Kaspi app-version constants editable by a super-admin without
 *    re-deploy — solves the version-gate problem where Kaspi's API returns
 *    OldVersionToUpdate when app_build is below the rolling floor.
 *    Seeded with live values from kaspi_pay_test/src/config.js.
 *    No RLS — poller and super-admin both need read without tenant context.
 *
 * GRANTs for kaspi_global_config: handled by ALTER DEFAULT PRIVILEGES set in
 * InitExtensions (SELECT/INSERT/UPDATE/DELETE already granted to shyraq_app
 * for all new tables in public schema).  No bespoke grants added.
 *
 * down() reverses in strict reverse order with IF EXISTS guards.
 */
export class B24KaspiPay1778680000000 implements MigrationInterface {
  name = 'B24KaspiPay1778680000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. kaspi_session_status ENUM ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE kaspi_session_status AS ENUM (
        'pending',
        'active',
        'expired',
        'revoked'
      )
    `);

    // ── 2. kaspi_merchant_session (tenant-scoped, FORCE RLS) ─────────────────
    await queryRunner.query(`
      CREATE TABLE "kaspi_merchant_session" (
        "id"                   uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"      uuid                   NOT NULL UNIQUE REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "connected_by_user_id" uuid                   NOT NULL REFERENCES "users"("id"),
        "status"               kaspi_session_status   NOT NULL DEFAULT 'pending',
        "cashier_phone"        varchar,
        "kaspi_profile_id"     varchar,
        "kaspi_org_id"         varchar,
        "org_name"             varchar,
        "token_sn"             text,
        "vtoken_secret_enc"    text,
        "device_keypair_enc"   text,
        "ecdh_keypair_enc"     text,
        "device_id"            varchar,
        "install_id"           varchar,
        "pin_hash"             varchar,
        "last_checked_at"      timestamptz,
        "created_at"           timestamptz            NOT NULL DEFAULT now(),
        "updated_at"           timestamptz            NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "idx_kaspi_merchant_session_kg_status"
        ON "kaspi_merchant_session" ("kindergarten_id", "status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "kaspi_merchant_session" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "kaspi_merchant_session" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "kaspi_merchant_session"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // Defence-in-depth: revoke TRUNCATE from the runtime app role.
    // RevokeTruncateFromAppRole already covers future tables via default
    // privileges, but we add an explicit revoke here so intent is visible
    // when reading only this file (mirrors B22ChildStatusHistory pattern).
    await queryRunner.query(
      `REVOKE TRUNCATE ON "kaspi_merchant_session" FROM ${appRoleIdent()}`,
    );

    // ── 3. kaspi_global_config (global, NO RLS, single-row) ──────────────────
    await queryRunner.query(`
      CREATE TABLE "kaspi_global_config" (
        "id"           int          PRIMARY KEY DEFAULT 1,
        "app_version"  varchar      NOT NULL,
        "app_build"    varchar      NOT NULL,
        "platform_ver" varchar      NOT NULL,
        "model"        varchar      NOT NULL,
        "brand"        varchar      NOT NULL,
        "ua_native"    varchar      NOT NULL,
        "ua_browser"   varchar      NOT NULL,
        "entrance_url" varchar      NOT NULL,
        "mtoken_url"   varchar      NOT NULL,
        "qrpay_url"    varchar      NOT NULL,
        "updated_by"   uuid         REFERENCES "users"("id"),
        "updated_at"   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "chk_kaspi_global_config_singleton" CHECK (id = 1)
      )
    `);

    // ── 4. Seed row for kaspi_global_config (live values from config.js) ─────
    // ua_native  = `Kaspi%20Pay/${build} ${cfNetwork} ${darwin}`
    //            = 'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0'
    // ua_browser = `Mozilla/5.0 (iPhone; CPU iPhone OS ${platformVer.replace('.','_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`
    //            = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
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
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: seed + kaspi_global_config → kaspi_merchant_session → ENUM

    // 4 + 3. kaspi_global_config (DROP TABLE implicitly removes the seed row)
    await queryRunner.query(`DROP TABLE IF EXISTS "kaspi_global_config"`);

    // 2. kaspi_merchant_session — drop policy, disable RLS, drop index, drop table
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "kaspi_merchant_session"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "kaspi_merchant_session" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "kaspi_merchant_session" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_kaspi_merchant_session_kg_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "kaspi_merchant_session"`);

    // 1. ENUM
    await queryRunner.query(`DROP TYPE IF EXISTS kaspi_session_status`);
  }
}
