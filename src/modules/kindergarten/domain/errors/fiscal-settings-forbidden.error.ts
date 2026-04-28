import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when a non-SuperAdmin caller attempts to set a `fiscal_*` settings
 * key via PATCH /api/v1/kindergartens/me/settings. Mapped to HTTP 403.
 */
export class FiscalSettingsForbiddenError extends DomainError {
  constructor() {
    super(
      'fiscal_settings_forbidden',
      'fiscal_* settings can only be changed by super_admin',
    );
  }
}
