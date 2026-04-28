import { DomainError } from './domain.error';

// Thrown when a PATCH permissions payload tries to override a locked key
// (prepayment, trusted_people_manage). Locked keys live in defaults only.
export class LockedPermissionKeyError extends DomainError {
  constructor(public readonly key: string) {
    super(
      'permission_key_locked',
      `permission key '${key}' is locked and cannot be overridden`,
    );
  }
}
