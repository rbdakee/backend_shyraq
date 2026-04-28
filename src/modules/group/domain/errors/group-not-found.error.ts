import { NotFoundError } from '@/shared-kernel/domain/errors';

export class GroupNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('group', id);
  }
}
