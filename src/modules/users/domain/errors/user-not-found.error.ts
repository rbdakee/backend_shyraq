import { NotFoundError } from '@/shared-kernel/domain/errors';

export class UserNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('user', id);
  }
}
