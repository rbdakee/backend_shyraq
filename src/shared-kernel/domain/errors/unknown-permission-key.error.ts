import { DomainError } from './domain.error';

// Thrown when a permissions payload contains a key not in the whitelist
// (toggleable + locked) or a non-boolean value for a known key.
export class UnknownPermissionKeyError extends DomainError {
  constructor(public readonly key: string) {
    super(
      'unknown_permission_key',
      `permission key '${key}' is not in the whitelist`,
    );
  }
}
