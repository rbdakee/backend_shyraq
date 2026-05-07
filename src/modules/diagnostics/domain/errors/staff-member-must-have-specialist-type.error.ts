import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — staff member calling `/staff/me/todos` (or admin overriding via
 * `?specialist_type=`) cannot resolve an effective `specialist_type`. The
 * my-todos algorithm is keyed on specialist_type — without it the service
 * cannot decide which children need a fresh diagnostic.
 *
 * Surfaces in two cases:
 *   - non-admin caller whose `staff_member.specialist_type` is null;
 *   - admin caller without their own specialist_type AND without a
 *     `specialist_type=` query override.
 */
export class StaffMemberMustHaveSpecialistTypeError extends ForbiddenActionError {
  public readonly code = 'staff_member_must_have_specialist_type' as const;

  constructor() {
    super(
      'staff_member_must_have_specialist_type',
      'staff member must have specialist_type to resolve diagnostic todos',
    );
  }
}
