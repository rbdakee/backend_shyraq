import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gate D needs the callback token for server-owned NOTIFY_URL construction.
 * The SHA-256 hash remains the callback lookup key; this ciphertext is only
 * decrypted inside trusted outbound BCC operations.
 */
export class AddBccCallbackTokenCiphertext1783348200000 implements MigrationInterface {
  name = 'AddBccCallbackTokenCiphertext1783348200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bcc_merchant_accounts"
      ADD COLUMN "callback_token_enc" text
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM "bcc_merchant_accounts") THEN
          RAISE EXCEPTION
            'BCC accounts created before Gate D must be re-provisioned before this migration';
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      ALTER TABLE "bcc_merchant_accounts"
      ALTER COLUMN "callback_token_enc" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "bcc_merchant_accounts"
      ADD CONSTRAINT "chk_bcc_merchant_accounts_callback_token_enc"
      CHECK (length(btrim("callback_token_enc")) > 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bcc_merchant_accounts"
      DROP CONSTRAINT IF EXISTS "chk_bcc_merchant_accounts_callback_token_enc"
    `);
    await queryRunner.query(`
      ALTER TABLE "bcc_merchant_accounts"
      DROP COLUMN IF EXISTS "callback_token_enc"
    `);
  }
}
