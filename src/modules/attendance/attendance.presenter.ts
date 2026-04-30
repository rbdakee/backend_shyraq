import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { ChildDailyStatus } from './domain/entities/child-daily-status.entity';
import { AttendanceEventResponseDto } from './dto/attendance-event.response';
import { DailyStatusResponseDto } from './dto/daily-status.response';

export class AttendancePresenter {
  static event(e: AttendanceEvent): AttendanceEventResponseDto {
    const s = e.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      eventType: s.eventType,
      method: s.method,
      recordedBy: s.recordedBy,
      pickupUserId: s.pickupUserId,
      pickupRequestId: s.pickupRequestId,
      notes: s.notes,
      recordedAt: s.recordedAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
    };
  }

  static dailyStatus(d: ChildDailyStatus): DailyStatusResponseDto {
    const s = d.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      date: s.date,
      status: s.status,
      note: s.note,
      setBy: s.setBy,
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}
