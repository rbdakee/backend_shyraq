import { DomainError } from '@/shared-kernel/domain/errors';

export class IinAlreadyTakenError extends DomainError {
  constructor() {
    super('iin_already_taken');
  }
}
