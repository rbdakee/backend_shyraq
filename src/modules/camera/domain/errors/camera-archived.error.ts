import { DomainError } from '@/shared-kernel/domain/errors';

export class CameraArchivedError extends DomainError {
  constructor(id: string) {
    super('camera_archived', `camera ${id} is archived`);
  }
}
