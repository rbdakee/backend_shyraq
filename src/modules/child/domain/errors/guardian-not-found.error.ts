import { NotFoundError } from '@/shared-kernel/domain/errors';

export class GuardianNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('child_guardian', id);
  }
}
