/**
 * The seed set of specialist types every kindergarten starts with. These rows
 * are inserted with `is_system = true` (non-deletable) both by the
 * `SpecialistTypesDirectory` migration (for existing kindergartens) and by the
 * `KindergartenService.createKindergarten` seed-hook (for new ones).
 *
 * The first five codes are the values of the old hard-coded
 * `specialist-type.vo.ts` enum — seeding them keeps every pre-existing
 * `staff_members.specialist_type` / `diagnostic_templates.specialist_type`
 * value valid after the directory becomes the authority (backward-compat).
 *
 * `doctor_nutritionist` ("Врач Нутрициолог") is the sixth, first-class role
 * requested alongside the directory work — a distinct role from `nutritionist`
 * ("Диетолог"), which stays.
 *
 * `name_i18n` values are SEED DEFAULTS: admins can rename them per-kindergarten
 * via `PATCH /admin/specialist-types/:id` (the frontend stops hard-coding
 * labels and reads `name_i18n` from here on).
 *
 * NOTE: the migration inlines this same list as SQL literals (raw-SQL migration
 * convention). Keep the two in sync when adding a system code.
 */
export interface SpecialistTypeLabels {
  ru: string;
  kk: string;
  [locale: string]: string;
}

export interface SystemSpecialistTypeSeed {
  code: string;
  nameI18n: SpecialistTypeLabels;
}

export const SYSTEM_SPECIALIST_TYPES: readonly SystemSpecialistTypeSeed[] = [
  { code: 'psychologist', nameI18n: { ru: 'Психолог', kk: 'Психолог' } },
  { code: 'speech_therapist', nameI18n: { ru: 'Логопед', kk: 'Логопед' } },
  {
    code: 'music_teacher',
    nameI18n: { ru: 'Музыкальный руководитель', kk: 'Музыка жетекшісі' },
  },
  {
    code: 'physical_ed',
    nameI18n: {
      ru: 'Инструктор по физкультуре',
      kk: 'Дене шынықтыру нұсқаушысы',
    },
  },
  { code: 'nutritionist', nameI18n: { ru: 'Диетолог', kk: 'Диетолог' } },
  {
    code: 'doctor_nutritionist',
    nameI18n: { ru: 'Врач Нутрициолог', kk: 'Нутрициолог дәрігер' },
  },
];

export const SYSTEM_SPECIALIST_TYPE_CODES: readonly string[] =
  SYSTEM_SPECIALIST_TYPES.map((s) => s.code);
