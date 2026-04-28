import { DomainError } from '@/shared-kernel/domain/errors';

export class GroupArchivedError extends DomainError {
  constructor(id: string) {
    super('group_archived', `group ${id} is archived`);
  }
}
