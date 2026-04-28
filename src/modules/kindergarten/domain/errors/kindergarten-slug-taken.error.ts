import { DomainError } from '@/shared-kernel/domain/errors';

export class KindergartenSlugTakenError extends DomainError {
  constructor(slug: string) {
    super('kindergarten_slug_taken', `slug already taken: ${slug}`);
  }
}
