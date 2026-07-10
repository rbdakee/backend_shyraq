/**
 * Specialist-type code.
 *
 * Historically a hard-coded enum (`psychologist | speech_therapist | …`). It is
 * now a plain `string` because the per-kindergarten `specialist_types`
 * directory (see `@/modules/specialist-type`) is the AUTHORITY on which codes
 * are valid. `staff_members.specialist_type` and
 * `diagnostic_templates.specialist_type` hold the code as a SOFT reference,
 * validated at the service layer via `SpecialistTypeService.assertUsableCode`
 * against the active directory.
 *
 * The domain (`StaffMember.validateRoleMatrix`) only enforces the presence
 * matrix (role=specialist ⇒ non-empty code; otherwise null). The seeded system
 * default codes live in `@/modules/specialist-type/domain/system-defaults`.
 */
export type SpecialistType = string;
