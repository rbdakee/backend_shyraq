import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * App-aware auth (STEP 3) — adds the `audience` column to `refresh_tokens`.
 *
 * The audience ('parent'|'staff'|'admin') the session belongs to is baked into
 * both the issued access token (`aud` claim) and the refresh-token row so that
 * `/auth/refresh` re-resolves roles filtered to the SAME app — a session can
 * never silently jump from Parent App into Admin/Staff scope on rotation.
 *
 * Nullable on purpose: rows issued before this migration carry NULL, which the
 * refresh path treats as "no audience filter" (legacy behavior) so existing
 * sessions keep rotating without forcing a re-login.
 *
 * varchar(16) comfortably fits the three audience literals with headroom.
 */
export class RefreshTokenAudience1778670000000 implements MigrationInterface {
  name = 'RefreshTokenAudience1778670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD COLUMN "audience" varchar(16)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP COLUMN "audience"`,
    );
  }
}
