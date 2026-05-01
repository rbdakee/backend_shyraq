import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — push_tokens row not found, or it belongs to a different user.
 * Returned by `DELETE /push-tokens/:id` when the caller is not the owner.
 */
export class PushTokenNotFoundError extends NotFoundError {
  public readonly code = 'push_token_not_found' as const;

  constructor(public readonly tokenId: string) {
    super('push_token', tokenId);
  }
}
