import { NotFoundError } from '@/shared-kernel/domain/errors';

export class SlotNotFoundError extends NotFoundError {
  public readonly code = 'slot_not_found' as const;

  constructor(public readonly slotId: string) {
    super('schedule_template_slot', slotId);
  }
}
