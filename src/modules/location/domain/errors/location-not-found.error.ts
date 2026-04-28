import { NotFoundError } from '@/shared-kernel/domain/errors';

export class LocationNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('location', id);
  }
}
