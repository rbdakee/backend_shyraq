import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin-managed, per-kindergarten `specialist_types` directory.
 *
 * Replaces the old hard-coded `specialist-type.vo.ts` enum as the AUTHORITY on
 * which `specialist_type` codes `staff_members` / `diagnostic_templates` may
 * use. Those tables keep their `varchar` column as a SOFT reference (no hard
 * FK) — validated at the service layer against the active directory. This keeps
 * every pre-existing value valid (backward-compatible) once the six system rows
 * below are seeded.
 *
 * 1. Creates `specialist_types` (tenant-scoped, FK→kindergartens.id) with a
 *    UNIQUE (kindergarten_id, code) index + RLS `tenant_isolation` policy
 *    (ENABLE + FORCE, SuperAdmin bypass honoured) mirroring `staff_members`.
 * 2. Seeds SIX system (`is_system=true`, non-deletable) rows for EVERY existing
 *    kindergarten: the five legacy enum values + `doctor_nutritionist`
 *    ("Врач Нутрициолог"). Labels here are SEED DEFAULTS — admins may rename
 *    them per-kindergarten. New kindergartens get the same rows via
 *    `KindergartenService.createKindergarten`'s seed-hook.
 *
 * Keep the seed list in sync with
 * `src/modules/specialist-type/domain/system-defaults.ts`.
 */
export class SpecialistTypesDirectory1783348500000 implements MigrationInterface {
  name = 'SpecialistTypesDirectory1783348500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Table
    await queryRunner.query(`
      CREATE TABLE "specialist_types" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kindergarten_id" uuid NOT NULL REFERENCES "kindergartens"("id") ON DELETE CASCADE,
        "code"            varchar(64) NOT NULL,
        "name_i18n"       jsonb NOT NULL,
        "is_system"       boolean NOT NULL DEFAULT false,
        "is_active"       boolean NOT NULL DEFAULT true,
        "sort_order"      integer NOT NULL DEFAULT 0,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_specialist_types_kg_code"
        ON "specialist_types" ("kindergarten_id", "code")
    `);

    // 2. RLS — tenant-scoped on kindergarten_id (mirrors staff_members).
    await queryRunner.query(
      `ALTER TABLE "specialist_types" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "specialist_types" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "specialist_types"
        USING (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
        WITH CHECK (
          coalesce(current_setting('app.bypass_rls', true), 'false') = 'true'
          OR kindergarten_id = nullif(current_setting('app.kindergarten_id', true), '')::uuid
        )
    `);

    // 3. Seed six system rows per existing kindergarten. Runs as the table
    //    owner (superuser) → bypasses the freshly-created RLS policy.
    await queryRunner.query(`
      INSERT INTO "specialist_types"
        ("kindergarten_id", "code", "name_i18n", "is_system", "is_active", "sort_order")
      SELECT k."id", v.code, v.name_i18n::jsonb, TRUE, TRUE, v.sort_order
      FROM "kindergartens" k
      CROSS JOIN (VALUES
        ('psychologist',        '{"ru":"Психолог","kk":"Психолог"}', 0),
        ('speech_therapist',    '{"ru":"Логопед","kk":"Логопед"}', 1),
        ('music_teacher',       '{"ru":"Музыкальный руководитель","kk":"Музыка жетекшісі"}', 2),
        ('physical_ed',         '{"ru":"Инструктор по физкультуре","kk":"Дене шынықтыру нұсқаушысы"}', 3),
        ('nutritionist',        '{"ru":"Диетолог","kk":"Диетолог"}', 4),
        ('doctor_nutritionist', '{"ru":"Врач Нутрициолог","kk":"Нутрициолог дәрігер"}', 5)
      ) AS v(code, name_i18n, sort_order)
      ON CONFLICT ("kindergarten_id", "code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "specialist_types"`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "specialist_types" NO FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "specialist_types" DISABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_specialist_types_kg_code"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "specialist_types"`);
  }
}
