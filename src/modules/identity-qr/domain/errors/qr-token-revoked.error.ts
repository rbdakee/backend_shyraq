import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 Gone — the QR token resolved but `revoked_at IS NOT NULL`. Either the
 * holder triggered an auto-refresh that revoked the previous token, or an
 * admin called `/admin/qr/revoke-all/:userId`. The client should request a
 * fresh QR via `GET /users/me/qr`.
 */
export class QrTokenRevokedError extends GoneError {
  public readonly code = 'qr_token_revoked' as const;

  constructor() {
    super('qr_token_revoked', 'qr token has been revoked');
  }
}
