import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised by `Enrollment.transitionTo(card_created, ...)` when one or more of
 * the lead-side fields required to materialise a child card are missing
 * (childName, childDob, contactName, contactPhone). Mapped to HTTP 422.
 */
export class EnrollmentMissingRequiredFieldsError extends DomainError {
  constructor(public readonly missingFields: readonly string[]) {
    super(
      'enrollment_missing_required_fields',
      `enrollment is missing required fields for card_created: ${missingFields.join(', ')}`,
    );
  }
}
