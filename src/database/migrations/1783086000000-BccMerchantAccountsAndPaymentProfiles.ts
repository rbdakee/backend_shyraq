import { MigrationInterface, QueryRunner } from 'typeorm';
import { appRoleIdent } from '../app-role.util';

/**
 * Gate B for BCC e-Commerce:
 *
 * - bcc_merchant_accounts: one encrypted credential set per kindergarten,
 *   tenant-scoped with FORCE RLS.
 * - user_payment_profiles: one provider-neutral, owner-scoped billing profile
 *   per user. This table is global across kindergartens and intentionally has
 *   no tenant RLS.
 */
export class BccMerchantAccountsAndPaymentProfiles1783086000000 implements MigrationInterface {
  name = 'BccMerchantAccountsAndPaymentProfiles1783086000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "bcc_merchant_accounts" (
        "id"                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id"            uuid        NOT NULL,
        "merchant_id"                varchar     NOT NULL,
        "terminal_id"                varchar     NOT NULL,
        "merchant_name"              varchar,
        "mac_key_enc"                text        NOT NULL,
        "environment"                varchar     NOT NULL DEFAULT 'test',
        "status"                     varchar     NOT NULL DEFAULT 'draft',
        "callback_token_hash"        char(64)    NOT NULL,
        "notify_username"            varchar     NOT NULL,
        "notify_password_hash"       varchar     NOT NULL,
        "last_connection_checked_at" timestamptz,
        "last_connection_result"     jsonb,
        "disabled_at"                timestamptz,
        "updated_by"                 uuid        NOT NULL,
        "created_at"                 timestamptz NOT NULL DEFAULT now(),
        "updated_at"                 timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "fk_bcc_merchant_accounts_kindergarten"
          FOREIGN KEY ("kindergarten_id")
          REFERENCES "kindergartens"("id")
          ON DELETE CASCADE,
        CONSTRAINT "fk_bcc_merchant_accounts_updated_by"
          FOREIGN KEY ("updated_by")
          REFERENCES "saas_users"("id"),
        CONSTRAINT "uq_bcc_merchant_accounts_kindergarten"
          UNIQUE ("kindergarten_id"),
        CONSTRAINT "uq_bcc_merchant_accounts_callback_token_hash"
          UNIQUE ("callback_token_hash"),
        CONSTRAINT "chk_bcc_merchant_accounts_environment"
          CHECK ("environment" IN ('test', 'live')),
        CONSTRAINT "chk_bcc_merchant_accounts_status"
          CHECK ("status" IN ('draft', 'active', 'disabled')),
        CONSTRAINT "chk_bcc_merchant_accounts_callback_token_hash"
          CHECK ("callback_token_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "chk_bcc_merchant_accounts_required_text"
          CHECK (
            length(btrim("merchant_id")) > 0
            AND length(btrim("terminal_id")) > 0
            AND length(btrim("mac_key_enc")) > 0
            AND length(btrim("notify_username")) > 0
            AND length(btrim("notify_password_hash")) > 0
          ),
        CONSTRAINT "chk_bcc_merchant_accounts_connection_result"
          CHECK (
            ("last_connection_checked_at" IS NULL AND "last_connection_result" IS NULL)
            OR (
              "last_connection_checked_at" IS NOT NULL
              AND "last_connection_result" IS NOT NULL
              AND jsonb_typeof("last_connection_result") = 'object'
              AND jsonb_typeof("last_connection_result" -> 'success') = 'boolean'
            )
          ),
        CONSTRAINT "chk_bcc_merchant_accounts_disabled_at"
          CHECK (
            ("status" = 'disabled' AND "disabled_at" IS NOT NULL)
            OR ("status" <> 'disabled' AND "disabled_at" IS NULL)
          )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_bcc_merchant_accounts_kg_status"
        ON "bcc_merchant_accounts" ("kindergarten_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_bcc_merchant_accounts_terminal_merchant"
        ON "bcc_merchant_accounts" ("terminal_id", "merchant_id")
    `);

    await queryRunner.query(
      `ALTER TABLE "bcc_merchant_accounts" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "bcc_merchant_accounts" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "bcc_merchant_accounts"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR "kindergarten_id" = nullif(
            current_setting('app.kindergarten_id', true),
            ''
          )::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR "kindergarten_id" = nullif(
            current_setting('app.kindergarten_id', true),
            ''
          )::uuid
        )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_payment_profiles" (
        "user_id"         uuid        PRIMARY KEY,
        "billing_phone"   varchar(20) NOT NULL,
        "billing_address" text        NOT NULL,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "fk_user_payment_profiles_user"
          FOREIGN KEY ("user_id")
          REFERENCES "users"("id")
          ON DELETE CASCADE,
        CONSTRAINT "chk_user_payment_profiles_billing_phone"
          CHECK (length(btrim("billing_phone")) > 0),
        CONSTRAINT "chk_user_payment_profiles_billing_address"
          CHECK (length(btrim("billing_address")) > 0)
      )
    `);

    await queryRunner.query(
      `REVOKE TRUNCATE ON "bcc_merchant_accounts" FROM ${appRoleIdent()}`,
    );
    await queryRunner.query(
      `REVOKE TRUNCATE ON "user_payment_profiles" FROM ${appRoleIdent()}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_payment_profiles"`);

    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "bcc_merchant_accounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "bcc_merchant_accounts" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "bcc_merchant_accounts" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_bcc_merchant_accounts_terminal_merchant"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_bcc_merchant_accounts_kg_status"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "bcc_merchant_accounts"`);
  }
}
