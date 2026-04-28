export class InvalidCredentialsError extends Error {
  readonly code = 'invalid_credentials';
  constructor() {
    super('invalid_credentials');
    this.name = 'InvalidCredentialsError';
  }
}
