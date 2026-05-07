import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — a nanny-role guardian attempted to access diagnostic entries or
 * progress notes for a child. Only primary/secondary guardians have
 * `permissions.view_diagnostics = true`. Nannies are excluded from this
 * surface per BP §8.5.
 */
export class NannyNoDiagnosticsAccessError extends ForbiddenActionError {
  public readonly code = 'nanny_no_diagnostics_access' as const;

  constructor() {
    super(
      'nanny_no_diagnostics_access',
      'nanny guardians cannot view diagnostic entries or progress notes',
    );
  }
}
