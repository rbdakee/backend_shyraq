export class RefreshInvalidError extends Error {
  readonly code = 'invalid_refresh';
  constructor() {
    super('invalid_refresh');
    this.name = 'RefreshInvalidError';
  }
}
