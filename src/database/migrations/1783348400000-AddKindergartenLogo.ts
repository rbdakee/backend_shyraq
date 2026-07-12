import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `kindergartens.logo_url` — a nullable canonical media reference for the
 * kindergarten's branding logo.
 *
 * The column stores the CANONICAL storage reference (the same
 * `/api/v1/media/<kgId>/<yyyy-mm>/<uuid>.<ext>` form that `content_posts`/
 * `group_stories` media use), NOT a presigned URL. The global
 * `MediaSignInterceptor` rewrites it into a short-lived presigned URL on every
 * response (Admin, Parent, Staff apps) — so a signed link is never persisted
 * and never goes stale.
 *
 * Additive + nullable: existing rows read back `logo_url = null`; older clients
 * that ignore the field are unaffected. No RLS change — the column lives on the
 * already-tenant-scoped `kindergartens` row.
 */
export class AddKindergartenLogo1783348400000 implements MigrationInterface {
  name = 'AddKindergartenLogo1783348400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "kindergartens" ADD COLUMN IF NOT EXISTS "logo_url" varchar(1024)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "kindergartens" DROP COLUMN IF EXISTS "logo_url"`,
    );
  }
}
