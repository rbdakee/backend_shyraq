import { NotFoundError } from '@/shared-kernel/domain/errors';

export class StaffNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('staff_member', id);
  }
}
