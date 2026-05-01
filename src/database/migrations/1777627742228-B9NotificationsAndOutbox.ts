import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B9 — Notifications & Outbox Tables.
 *
 * Tables (creation order respects FK deps):
 *   1. push_tokens                  (global per-user; NO RLS; unique (user_id, token))
 *   2. notifications                (tenant-scoped; FORCE RLS; partial idx for unread_only)
 *   3. notification_preferences     (global per-user per-event; NO RLS; unique (user_id, event_key))
 *   4. notification_outbox          (tenant-scoped; FORCE RLS; partial idx on (status, next_retry_at))
 *
 * RLS pattern identical to B7/B8:
 *   ENABLE + FORCE ROW LEVEL SECURITY, policy `tenant_isolation`
 *   USING + WITH CHECK via coalesce(bypass_rls) OR kindergarten_id = setting::uuid.
 *
 * push_tokens and notification_preferences are intentionally global (no RLS) —
 * they are keyed on user_id only and accessed cross-tenant by the worker.
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions — no
 * per-table GRANT needed for new tables created by the migration owner role.
 */
export class B9NotificationsAndOutbox1777627742228 implements MigrationInterface {
  name = 'B9NotificationsAndOutbox1777627742228';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. push_tokens ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "push_tokens" (
        "id"           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"      uuid         NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "token"        varchar(512) NOT NULL,
        "platform"     varchar(16)  NOT NULL,
        "app_version"  varchar(32),
        "device_id"    varchar(128),
        "last_seen_at" timestamptz  NOT NULL DEFAULT now(),
        "created_at"   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "chk_push_tokens_platform"
          CHECK (platform IN ('ios', 'android', 'web'))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_push_tokens_user_token"
        ON "push_tokens" ("user_id", "token")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_push_tokens_user_id"
        ON "push_tokens" ("user_id")
    `);

    // ── 2. notifications ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "user_id"         uuid        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "event_key"       varchar(64) NOT NULL,
        "title_i18n"      jsonb       NOT NULL,
        "body_i18n"       jsonb       NOT NULL,
        "data"            jsonb       NOT NULL DEFAULT '{}'::jsonb,
        "read_at"         timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_notifications_kg_user_created"
        ON "notifications" ("kindergarten_id", "user_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_notifications_unread"
        ON "notifications" ("kindergarten_id", "user_id", "created_at" DESC)
        WHERE read_at IS NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "notifications"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // ── 3. notification_preferences ───────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notification_preferences" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"         uuid        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "event_key"       varchar(64) NOT NULL,
        "push_enabled"    boolean     NOT NULL DEFAULT true,
        "in_app_enabled"  boolean     NOT NULL DEFAULT true,
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_notification_prefs_user_event"
        ON "notification_preferences" ("user_id", "event_key")
    `);

    // ── 4. notification_outbox ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "notification_outbox" (
        "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid        NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "event_key"       varchar(64) NOT NULL,
        "payload"         jsonb       NOT NULL,
        "status"          varchar(16) NOT NULL DEFAULT 'pending',
        "attempts"        int         NOT NULL DEFAULT 0,
        "next_retry_at"   timestamptz NOT NULL DEFAULT now(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "dispatched_at"   timestamptz,
        "failed_reason"   text,
        CONSTRAINT "chk_outbox_status"
          CHECK (status IN ('pending', 'dispatched', 'failed'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_outbox_pending"
        ON "notification_outbox" ("status", "next_retry_at")
        WHERE status = 'pending'
    `);

    await queryRunner.query(
      `ALTER TABLE "notification_outbox" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_outbox" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "notification_outbox"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: notification_outbox → notification_preferences → notifications → push_tokens

    // 4. notification_outbox
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "notification_outbox"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "notification_outbox" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "notification_outbox" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_pending"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_outbox"`);

    // 3. notification_preferences
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notification_prefs_user_event"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notification_preferences"`);

    // 2. notifications
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "notifications"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "notifications" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "notifications" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_notifications_unread"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_notifications_kg_user_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications"`);

    // 1. push_tokens
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_push_tokens_user_id"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_push_tokens_user_token"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "push_tokens"`);
  }
}
