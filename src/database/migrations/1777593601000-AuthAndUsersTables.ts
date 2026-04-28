import { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthAndUsersTables1777593601000 implements MigrationInterface {
  name = 'AuthAndUsersTables1777593601000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "saas_user_role" AS ENUM ('super_admin', 'support')
    `);

    await queryRunner.query(`
      CREATE TABLE "kindergartens" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"       varchar NOT NULL,
        "slug"       varchar UNIQUE NOT NULL,
        "address"    text,
        "phone"      varchar,
        "settings"   jsonb NOT NULL DEFAULT '{}'::jsonb,
        "plan"       varchar NOT NULL DEFAULT 'standard',
        "is_active"  boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "phone"         varchar(20) UNIQUE NOT NULL,
        "full_name"     varchar NOT NULL,
        "avatar_url"    text,
        "iin"           char(12) UNIQUE,
        "date_of_birth" date,
        "locale"        varchar(5) NOT NULL DEFAULT 'ru',
        "is_active"     boolean NOT NULL DEFAULT true,
        "last_login_at" timestamptz,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_users_phone" ON "users" ("phone")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_users_iin" ON "users" ("iin")`);

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "kindergarten_id" uuid REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "token_hash"      varchar UNIQUE NOT NULL,
        "device_id"       varchar,
        "ip_address"      varchar,
        "expires_at"      timestamptz NOT NULL,
        "revoked_at"      timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_user_id" ON "refresh_tokens" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_kindergarten_id" ON "refresh_tokens" ("kindergarten_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "saas_users" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email"         varchar UNIQUE NOT NULL,
        "phone"         varchar(20) UNIQUE,
        "full_name"     varchar NOT NULL,
        "password_hash" varchar NOT NULL,
        "role"          saas_user_role NOT NULL,
        "is_active"     boolean NOT NULL DEFAULT true,
        "last_login_at" timestamptz,
        "created_at"    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "saas_refresh_tokens" (
        "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "saas_user_id" uuid NOT NULL REFERENCES "saas_users"("id") ON DELETE CASCADE,
        "token_hash"   varchar UNIQUE NOT NULL,
        "device_id"    varchar,
        "ip_address"   varchar,
        "expires_at"   timestamptz NOT NULL,
        "revoked_at"   timestamptz,
        "created_at"   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_saas_refresh_tokens_saas_user_id" ON "saas_refresh_tokens" ("saas_user_id")`,
    );

    // RLS — tenant-scoped tables.
    // Policy lets through rows where (kindergarten_id matches current_setting)
    // OR the bypass GUC is set to 'true' (used by SuperAdmin context).
    // refresh_tokens.kindergarten_id is nullable (issued before role-select),
    // so we permit NULL kg rows when user owns them — checked via app code.
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "refresh_tokens"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id IS NULL
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id IS NULL
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // kindergartens.id is the tenant key itself.
    await queryRunner.query(
      `ALTER TABLE "kindergartens" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "kindergartens"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // users / saas_users / saas_refresh_tokens are NOT tenant-scoped:
    // - users: shared identity across kindergartens (one phone -> N kg roles)
    // - saas_users + saas_refresh_tokens: SaaS-level, never bound to a kg
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "kindergartens"`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "refresh_tokens"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "saas_refresh_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "saas_users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "kindergartens"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "saas_user_role"`);
  }
}
