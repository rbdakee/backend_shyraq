export class NoRoleForAppError extends Error {
  readonly code = 'no_role_for_app';
  constructor() {
    super('no_role_for_app');
    this.name = 'NoRoleForAppError';
  }
}
