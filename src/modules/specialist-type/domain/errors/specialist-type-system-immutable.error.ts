import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Attempted to DELETE a system (seeded, non-deletable) specialist type. The
 * client should deactivate it (`is_active = false`) instead. Mapped to 409.
 */
export class SpecialistTypeSystemImmutableError extends ConflictError {
  constructor(code: string) {
    super(
      'specialist_type_system_immutable',
      `system specialist_type cannot be deleted: ${code}`,
    );
  }
}
