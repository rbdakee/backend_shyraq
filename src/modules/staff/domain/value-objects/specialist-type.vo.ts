import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * D4 specialist-type whitelist. The DB column stays `varchar(64)`; this VO
 * is defense-in-depth behind the DTO-level `@IsEnum`. Add a new value =
 * one-line tuple extension; nothing else needs to change.
 */
export const SPECIALIST_TYPES = [
  'psychologist',
  'speech_therapist',
  'music_teacher',
  'physical_ed',
  'nutritionist',
] as const;

export type SpecialistType = (typeof SPECIALIST_TYPES)[number];

export function isSpecialistType(input: unknown): input is SpecialistType {
  return (
    typeof input === 'string' &&
    (SPECIALIST_TYPES as readonly string[]).includes(input)
  );
}

export function parseSpecialistType(input: unknown): SpecialistType {
  if (!isSpecialistType(input)) {
    throw new InvariantViolationError(
      `invalid specialist_type: ${String(input)}`,
    );
  }
  return input;
}
