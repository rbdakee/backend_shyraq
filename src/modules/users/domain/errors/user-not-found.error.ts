import { NotFoundError } from '@/shared-kernel/domain/errors';

export interface UserNotFoundOptions {
  /**
   * Stable error code surfaced via `DomainErrorFilter`. Defaults to
   * `'user_not_found'`. Auth-adjacent flows (login, password reset,
   * refresh) override to a neutral code such as `'invalid_credentials'`
   * so the HTTP response cannot be used to enumerate which user-ids
   * exist (BP §3.1 security-by-uniform-response).
   *
   * B22b T12: the original carry-forward in `IMPLEMENTATION_PLAN.md §5
   * Active` asked for a per-call-site override on `UserNotFoundError`
   * rather than a separate `InvalidCredentialsError` class so callers
   * keep a single throw-site for "no user behind this identifier" and
   * the masking decision is explicit at the call site.
   */
  codeOverride?: string;
}

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
 *
 * B22b T12: optional `codeOverride` constructor param lets auth flows
 * mask the code as `invalid_credentials` so HTTP responses cannot be
 * used to enumerate which user-ids exist. Default remains
 * `user_not_found` for all non-auth callers (admin QR revoke, /users/me,
 * etc.).
 */
export class UserNotFoundError extends NotFoundError {
  constructor(id: string, options?: UserNotFoundOptions) {
    super('user', id);
    Object.defineProperty(this, 'code', {
      value: options?.codeOverride ?? 'user_not_found',
      enumerable: true,
      configurable: true,
      writable: false,
    });
  }
}
