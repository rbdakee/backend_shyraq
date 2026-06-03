export class NotInvitedError extends Error {
  readonly code = 'not_invited';
  constructor() {
    super('not_invited');
    this.name = 'NotInvitedError';
  }
}
