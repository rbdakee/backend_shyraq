import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { ChildDailyStatus } from './domain/entities/child-daily-status.entity';
import { AttendanceEventResponseDto } from './dto/attendance-event.response';
import { DailyStatusResponseDto } from './dto/daily-status.response';

export class AttendancePresenter {
  /**
   * Maps an attendance event → response DTO. The optional overlay params
   * carry display names resolved by the service (the row stores only ids):
   *   - `recordedByFullName` — staff_members.id → users.full_name.
   *   - `pickupUserFullName` — users.id → users.full_name (check_out only).
   *   - `childName` — children.id → children.full_name (incl. archived).
   * Absent overlay → the respective `*_full_name` / `child_name` falls back
   * to null. Mirrors `ProgressNotePresenter.one`'s `mentorFullName` overlay.
   */
  static event(
    e: AttendanceEvent,
    recordedByFullName: string | null = null,
    pickupUserFullName: string | null = null,
    childName: string | null = null,
  ): AttendanceEventResponseDto {
    const s = e.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      child_name: childName,
      eventType: s.eventType,
      method: s.method,
      recordedBy: s.recordedBy,
      recorded_by_full_name: recordedByFullName,
      pickupUserId: s.pickupUserId,
      pickup_user_full_name: pickupUserFullName,
      pickupRequestId: s.pickupRequestId,
      notes: s.notes,
      recordedAt: s.recordedAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
    };
  }

  /**
   * Maps a daily-status row → response DTO. The optional `setByFullName`
   * overlay carries the display name resolved from staff_members.id →
   * users.full_name (the row stores only `set_by`). Absent overlay →
   * `set_by_full_name` falls back to null.
   */
  static dailyStatus(
    d: ChildDailyStatus,
    setByFullName: string | null = null,
  ): DailyStatusResponseDto {
    const s = d.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      date: s.date,
      status: s.status,
      note: s.note,
      setBy: s.setBy,
      set_by_full_name: setByFullName,
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}
