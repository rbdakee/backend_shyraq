import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a content_posts row that is not visible under
 * the caller's tenant scope (or simply does not exist).
 */
export class ContentPostNotFoundError extends NotFoundError {
  public readonly code = 'content_post_not_found' as const;

  constructor(contentPostId: string) {
    super('content_post', contentPostId);
  }
}
