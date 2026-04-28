export class NoActiveRolesError extends Error {
  readonly code = 'no_active_roles';
  constructor() {
    super('no_active_roles');
    this.name = 'NoActiveRolesError';
  }
}
