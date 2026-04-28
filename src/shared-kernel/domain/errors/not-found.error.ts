import { DomainError } from './domain.error';

export class NotFoundError extends DomainError {
  constructor(entity: string, key: string) {
    super('not_found', `${entity} not found: ${key}`);
  }
}
