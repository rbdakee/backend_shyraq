import {
  DomainError,
  InvariantViolationError,
} from '@/shared-kernel/domain/errors';

export class BccCallbackUnauthorizedError extends DomainError {
  constructor() {
    super('bcc_callback_unauthorized');
  }
}

export class BccCallbackInvalidError extends InvariantViolationError {
  constructor() {
    super('bcc_callback_invalid');
  }
}
