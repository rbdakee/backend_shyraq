import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B20/C1 — CCTV stream metadata on `cameras`.
 *
 * The live stack is a cloud go2rtc gateway reached over a WireGuard tunnel
 * (NOT the per-kindergarten MediaMTX edge box of decision D15 — see
 * docs/architecture.md). go2rtc addresses a camera by a *stream key* from its
 * own config (`cam02_sub`), not by the RTSP URL we store, so the row needs to
 * carry that key:
 *
 *   - `stream_key`     — the low-res sub-stream (704x576). What parents watch,
 *                        and what the grid view in the admin panel tiles.
 *   - `stream_key_hd`  — optional full-res main stream for single-camera view.
 *   - `video_codec`    — last probed codec, filled in automatically by the
 *                        codec-probe job. NEVER hand-maintained: the whole
 *                        point is that when a kindergarten flips a camera from
 *                        H.265 to H.264 the backend notices on its own and
 *                        starts offering the WebRTC variant alongside HLS.
 *   - `codec_checked_at` — when that probe last succeeded (NULL = never).
 *
 * Both stream-key indexes are UNIQUE **globally**, not per tenant. go2rtc has
 * one flat stream namespace shared by every kindergarten, so two rows holding
 * the same key would let one tenant's parents watch another tenant's camera —
 * the one cross-tenant leak RLS cannot catch, because the key is resolved
 * outside the database. The unique index fires 23505 even when the conflicting
 * row is invisible under RLS; the repository maps that to a domain error that
 * does not reveal who holds the key.
 */
export class CctvStreamMetadata1789397994271 implements MigrationInterface {
  name = 'CctvStreamMetadata1789397994271';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "cameras"
        ADD COLUMN "stream_key"       varchar(128),
        ADD COLUMN "stream_key_hd"    varchar(128),
        ADD COLUMN "video_codec"      varchar(16),
        ADD COLUMN "codec_checked_at" timestamptz
    `);

    await queryRunner.query(`
      ALTER TABLE "cameras"
        ADD CONSTRAINT "chk_cameras_video_codec"
        CHECK ("video_codec" IS NULL OR "video_codec" IN ('h264', 'h265', 'unknown'))
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_cameras_stream_key"
        ON "cameras" ("stream_key")
        WHERE "stream_key" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_cameras_stream_key_hd"
        ON "cameras" ("stream_key_hd")
        WHERE "stream_key_hd" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_cameras_stream_key_hd"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_cameras_stream_key"`);
    await queryRunner.query(
      `ALTER TABLE "cameras" DROP CONSTRAINT IF EXISTS "chk_cameras_video_codec"`,
    );
    await queryRunner.query(`
      ALTER TABLE "cameras"
        DROP COLUMN IF EXISTS "codec_checked_at",
        DROP COLUMN IF EXISTS "video_codec",
        DROP COLUMN IF EXISTS "stream_key_hd",
        DROP COLUMN IF EXISTS "stream_key"
    `);
  }
}
