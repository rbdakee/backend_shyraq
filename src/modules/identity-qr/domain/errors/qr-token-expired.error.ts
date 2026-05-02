import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 Gone — the QR token resolved but its `expires_at` has passed. The
 * client should request a fresh QR via `GET /users/me/qr` (which auto-
 * refreshes once `expires_at - now < 1h`).
 */
export class QrTokenExpiredError extends GoneError {
  public readonly code = 'qr_token_expired' as const;

  constructor() {
    super('qr_token_expired', 'qr token has expired');
  }
}
