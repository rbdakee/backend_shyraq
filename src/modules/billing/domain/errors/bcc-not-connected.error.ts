import { ConflictError } from '@/shared-kernel/domain/errors';

export class BccNotConnectedError extends ConflictError {
  public readonly code = 'bcc_not_connected' as const;

  constructor() {
    super(
      'bcc_not_connected',
      'BCC merchant account is not active for this kindergarten',
    );
  }
}
