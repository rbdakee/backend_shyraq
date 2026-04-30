import { ScheduleTemplate } from '../../domain/entities/schedule-template.entity';

export interface ListScheduleTemplatesFilter {
  groupId?: string | null;
  isActive?: boolean;
}

/**
 * Port over `schedule_templates` + `schedule_template_slots`. The slots are
 * always returned eagerly inside the aggregate so the domain can run its
 * conflict-detection invariants. Service.ts always passes `kindergartenId`
 * explicitly — RLS is defense-in-depth.
 */
export abstract class ScheduleTemplateRepository {
  abstract create(
    kindergartenId: string,
    template: ScheduleTemplate,
  ): Promise<ScheduleTemplate>;

  abstract findById(
    kindergartenId: string,
    templateId: string,
  ): Promise<ScheduleTemplate | null>;

  abstract list(
    kindergartenId: string,
    filter: ListScheduleTemplatesFilter,
  ): Promise<ScheduleTemplate[]>;

  abstract listActiveValidOn(
    kindergartenId: string,
    date: Date,
  ): Promise<ScheduleTemplate[]>;

  /**
   * Save the aggregate and reconcile its slot collection against the DB
   * (insert new slots, update existing, delete missing). One transactional
   * call so the partial-unique constraint never sees a mid-state.
   */
  abstract save(
    kindergartenId: string,
    template: ScheduleTemplate,
  ): Promise<ScheduleTemplate>;

  abstract delete(kindergartenId: string, templateId: string): Promise<void>;
}
