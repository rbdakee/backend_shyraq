import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B10 — Identity QR Tokens.
 *
 * Adds the `user_qr_tokens` table and `qr_purpose` enum for the Identity QR
 * feature (B10). Cross-tenant by design — NO RLS, NO FORCE RLS, no
 * `tenant_isolation` policy. A user may have children in multiple kindergartens
 * but uses a single QR; `kindergarten_id` is therefore nullable.
 *
 * Table: user_qr_tokens
 *   - id              uuid PK
 *   - user_id         uuid → users(id) ON DELETE CASCADE
 *   - kindergarten_id uuid → kindergartens(id) ON DELETE SET NULL (nullable)
 *   - purpose         qr_purpose NOT NULL DEFAULT 'identity'
 *   - token_hash      varchar(64) UNIQUE NOT NULL  (SHA-256 hex; plaintext only in Redis)
 *   - issued_at       timestamptz NOT NULL DEFAULT NOW()
 *   - expires_at      timestamptz NOT NULL
 *   - revoked_at      timestamptz NULL
 *   - last_scanned_at timestamptz NULL
 *
 * Indexes:
 *   idx_user_qr_tokens_user_purpose  — composite (user_id, purpose)
 *   idx_user_qr_tokens_expires_at    — (expires_at) for TTL-sweep queries
 *   idx_user_qr_tokens_one_active    — UNIQUE (user_id, purpose) WHERE revoked_at IS NULL
 *     Partial predicate uses only IMMUTABLE condition (no NOW()). Active-uniqueness
 *     invariant enforced in code via revoke-old-then-insert-new TX.
 *
 * GRANTs: handled by ALTER DEFAULT PRIVILEGES set in InitExtensions.
 */
export class B10IdentityQr1777688591994 implements MigrationInterface {
  name = 'B10IdentityQr1777688591994';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. qr_purpose ENUM ────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE qr_purpose AS ENUM (
        'identity'
      )
    `);

    // ── 2. user_qr_tokens ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "user_qr_tokens" (
        "id"              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"         uuid         NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "kindergarten_id" uuid                  REFERENCES "kindergartens"("id") ON DELETE SET NULL,
        "purpose"         qr_purpose   NOT NULL DEFAULT 'identity',
        "token_hash"      varchar(64)  NOT NULL UNIQUE,
        "issued_at"       timestamptz  NOT NULL DEFAULT NOW(),
        "expires_at"      timestamptz  NOT NULL,
        "revoked_at"      timestamptz,
        "last_scanned_at" timestamptz
      )
    `);

    await queryRunner.query(`
      COMMENT ON TABLE "user_qr_tokens" IS 'Identity QR tokens. Cross-tenant by design (no RLS). Plaintext tokens stored only in Redis (qr:token:{plaintext}); DB stores SHA-256 hash in token_hash.'
    `);

    // ── 3. Indexes ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE INDEX "idx_user_qr_tokens_user_purpose"
        ON "user_qr_tokens" ("user_id", "purpose")
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_user_qr_tokens_expires_at"
        ON "user_qr_tokens" ("expires_at")
    `);

    // Partial unique index — IMMUTABLE predicate only (no NOW()).
    // Active-uniqueness invariant ((user_id, purpose) one active) is enforced
    // in code via revoke-old-then-insert-new TX. This idx catches duplicate
    // non-revoked rows but does not by itself prove "active" because revoked_at
    // can still be NULL on an expired-but-not-yet-revoked row.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_user_qr_tokens_one_active"
        ON "user_qr_tokens" ("user_id", "purpose")
        WHERE revoked_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: indexes → table → enum

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_user_qr_tokens_one_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_user_qr_tokens_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_user_qr_tokens_user_purpose"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "user_qr_tokens"`);
    await queryRunner.query(`DROP TYPE IF EXISTS qr_purpose`);
  }
}
