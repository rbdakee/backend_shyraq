import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * No active/known specialist-type row for the given code or id in this
 * kindergarten. Mapped to HTTP 404 by `DomainErrorFilter`.
 */
export class SpecialistTypeNotFoundError extends DomainError {
  constructor(codeOrId: string) {
    super(
      'specialist_type_not_found',
      `specialist_type not found: ${codeOrId}`,
    );
  }
}
