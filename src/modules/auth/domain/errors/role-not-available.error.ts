export class RoleNotAvailableError extends Error {
  readonly code = 'role_not_available';
  constructor() {
    super('role_not_available');
    this.name = 'RoleNotAvailableError';
  }
}
