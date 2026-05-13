export interface KindergartenHolidayState {
  id: string;
  kindergartenId: string;
  date: Date;
  name: Record<string, string>;
  isBillable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Per-kindergarten holiday (or non-billable closure) entry. `name` is a
 * locale map (`{ ru: '…', kk: '…' }`) — at least one locale key is
 * required. `isBillable=false` excludes the day from pro-rata calculations.
 */
export class KindergartenHoliday {
  private constructor(private readonly state: KindergartenHolidayState) {
    if (Object.keys(state.name).length === 0) {
      throw new Error(
        'KindergartenHoliday: name must contain at least one locale key',
      );
    }
  }

  static fromState(s: KindergartenHolidayState): KindergartenHoliday {
    return new KindergartenHoliday({ ...s });
  }

  toState(): KindergartenHolidayState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get date(): Date {
    return this.state.date;
  }

  get name(): Record<string, string> {
    return this.state.name;
  }

  get isBillable(): boolean {
    return this.state.isBillable;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }
}
