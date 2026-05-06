import { ScheduleTemplate } from '../../../../domain/entities/schedule-template.entity';
import { ScheduleTemplateSlot } from '../../../../domain/entities/schedule-template-slot.entity';
import { DayOfWeekValue } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { ScheduleTemplateEntity } from '../entities/schedule-template.entity';
import { ScheduleTemplateSlotEntity } from '../entities/schedule-template-slot.entity';

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function toDateOrNull(v: Date | string | null): Date | null {
  return v === null ? null : toDate(v);
}

export class ScheduleTemplateMapper {
  static slotToDomain(row: ScheduleTemplateSlotEntity): ScheduleTemplateSlot {
    return ScheduleTemplateSlot.hydrate({
      id: row.id,
      templateId: row.template_id,
      dayOfWeek: row.day_of_week as DayOfWeekValue,
      startTime: row.start_time,
      endTime: row.end_time,
      activityName: row.activity_name,
      locationId: row.location_id,
      description: row.description,
    });
  }

  static toDomain(row: ScheduleTemplateEntity): ScheduleTemplate {
    const slots = (row.slots ?? []).map((s) =>
      ScheduleTemplateMapper.slotToDomain(s).toState(),
    );
    return ScheduleTemplate.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      groupId: row.group_id,
      name: row.name,
      recurrence: row.recurrence,
      isActive: row.is_active,
      validFrom: toDate(row.valid_from),
      validUntil: toDateOrNull(row.valid_until),
      createdAt: row.created_at,
      slots,
    });
  }
}
