import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — caller-supplied entry `data` payload does not satisfy the bound
 * template's `schema`. `details` identifies the offending field key, what
 * the schema expected, and what was actually supplied so the client can
 * pin-point the bad input.
 */
export class DiagnosticEntryDataInvalidError extends InvariantViolationError {
  public readonly code = 'diagnostic_entry_data_invalid' as const;
  public readonly details: {
    path: string;
    expected: string;
    actual: string;
  };

  constructor(details: { path: string; expected: string; actual: string }) {
    super('diagnostic_entry_data_invalid');
    this.details = details;
  }
}
