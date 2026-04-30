import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404-mapped error: the schedule_templates row does not exist (or RLS hides
 * it from the caller's tenant). The `code` is module-specific so the API
 * client can disambiguate from generic `not_found`.
 */
export class ScheduleTemplateNotFoundError extends NotFoundError {
  public readonly code = 'schedule_template_not_found' as const;

  constructor(public readonly templateId: string) {
    super('schedule_template', templateId);
  }
}
