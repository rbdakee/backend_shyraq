import { NotFoundError } from '@/shared-kernel/domain/errors';

export class CameraNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('camera', id);
  }
}
