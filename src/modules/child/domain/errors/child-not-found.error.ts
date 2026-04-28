import { NotFoundError } from '@/shared-kernel/domain/errors';

export class ChildNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('child', id);
  }
}
