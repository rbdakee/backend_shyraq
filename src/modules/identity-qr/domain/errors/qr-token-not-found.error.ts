import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — a scan presented a token plaintext that does not resolve to any known
 * QR row (Redis miss + DB miss). The `code` is module-specific so API
 * clients can disambiguate from generic `not_found`.
 */
export class QrTokenNotFoundError extends NotFoundError {
  public readonly code = 'qr_token_not_found' as const;

  constructor() {
    super('qr_token', 'unknown');
  }
}
