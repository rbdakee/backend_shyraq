import { DomainError } from '@/shared-kernel/domain/errors';

export class GroupTransferToSelfError extends DomainError {
  constructor() {
    super('group_transfer_to_self', 'child is already in the target group');
  }
}
