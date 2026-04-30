export type WeekSnapshotSource = 'cron' | 'manual';

export interface ScheduleWeekSnapshotState {
  id: string;
  kindergartenId: string;
  groupId: string;
  weekStartDate: Date;
  source: WeekSnapshotSource;
  copiedFrom: string | null;
  createdAt: Date;
}

export interface CreateScheduleWeekSnapshotInput {
  id: string;
  kindergartenId: string;
  groupId: string;
  weekStartDate: Date;
  source: WeekSnapshotSource;
  copiedFrom?: string | null;
}

/**
 * Plain CRUD entity — the snapshot is a flag row written by `copyWeekToNext`
 * at the end of a successful copy. No invariants beyond "Mon-aligned date" —
 * which the service enforces at the input boundary.
 */
export class ScheduleWeekSnapshot {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly groupId: string,
    readonly weekStartDate: Date,
    readonly source: WeekSnapshotSource,
    readonly copiedFrom: string | null,
    readonly createdAt: Date,
  ) {}

  static createNew(
    input: CreateScheduleWeekSnapshotInput,
    now: Date,
  ): ScheduleWeekSnapshot {
    return new ScheduleWeekSnapshot(
      input.id,
      input.kindergartenId,
      input.groupId,
      input.weekStartDate,
      input.source,
      input.copiedFrom ?? null,
      now,
    );
  }

  static hydrate(state: ScheduleWeekSnapshotState): ScheduleWeekSnapshot {
    return new ScheduleWeekSnapshot(
      state.id,
      state.kindergartenId,
      state.groupId,
      state.weekStartDate,
      state.source,
      state.copiedFrom,
      state.createdAt,
    );
  }

  toState(): ScheduleWeekSnapshotState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      groupId: this.groupId,
      weekStartDate: this.weekStartDate,
      source: this.source,
      copiedFrom: this.copiedFrom,
      createdAt: this.createdAt,
    };
  }
}
