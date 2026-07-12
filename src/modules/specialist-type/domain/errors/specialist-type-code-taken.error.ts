import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * A specialist-type row with the same `code` already exists in this
 * kindergarten (codes are unique per-tenant). Mapped to HTTP 409.
 */
export class SpecialistTypeCodeTakenError extends ConflictError {
  constructor(code: string) {
    super('specialist_type_code_taken', `specialist_type code taken: ${code}`);
  }
}
