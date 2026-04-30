import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — slot must satisfy `start_time < end_time` and the times must be
 * 24-hour `HH:MM` (or `HH:MM:SS`). Used both by domain factory and by the
 * service when patching a slot via UpdateSlot.
 */
export class InvalidSlotTimeError extends InvariantViolationError {
  public readonly code = 'invalid_slot_time' as const;

  constructor(
    public readonly startTime: string,
    public readonly endTime: string,
  ) {
    super(`invalid slot time range: ${startTime} → ${endTime}`);
  }
}
