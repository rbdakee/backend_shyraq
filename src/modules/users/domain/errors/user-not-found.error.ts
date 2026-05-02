import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * Distinct from the generic `NotFoundError` ("user not found: <id>") via
 * the stable error code `user_not_found` that the docs and clients
 * pattern-match against (e.g. POST /admin/qr/revoke-all/:userId returns
 * `user_not_found` when the userId does not exist). Still extends
 * `NotFoundError` so the DomainErrorFilter maps it to 404 via the
 * `instanceof NotFoundError` branch.
 *
 * `code` is overridden via Object.defineProperty because the parent
 * `DomainError` exposes it as `public readonly`; assignment in the
 * subclass body would be a TS error and writing through `(this as any)` is
 * a smell — defineProperty is the explicit, type-safe way.
 */
export class UserNotFoundError extends NotFoundError {
  constructor(id: string) {
    super('user', id);
    Object.defineProperty(this, 'code', {
      value: 'user_not_found',
      enumerable: true,
      configurable: true,
      writable: false,
    });
  }
}
