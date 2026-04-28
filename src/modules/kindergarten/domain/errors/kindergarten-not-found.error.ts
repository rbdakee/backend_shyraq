import { DomainError } from '@/shared-kernel/domain/errors/domain.error';

export class KindergartenNotFoundError extends DomainError {
  constructor(id: string) {
    super('kindergarten_not_found', `kindergarten not found: ${id}`);
  }
}
