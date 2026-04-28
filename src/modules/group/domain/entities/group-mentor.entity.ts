/**
 * GroupMentor — append-only assignment record for the mentor lifecycle of a
 * group. The DB enforces the partial-unique index
 *   `idx_group_mentors_one_active ON group_mentors (group_id) WHERE unassigned_at IS NULL`
 * which guarantees at most one active row per group. Re-assignment is
 * implemented by the service layer in a single TX:
 *   1. close (set unassigned_at) the currently active row, if any
 *   2. insert a new row with unassigned_at IS NULL
 * On a race the unique index fires 23505 and the service maps it to a
 * domain error.
 */
export interface GroupMentorState {
  id: string;
  kindergartenId: string;
  groupId: string;
  staffMemberId: string;
  isPrimary: boolean;
  assignedAt: Date;
  unassignedAt: Date | null;
  createdAt: Date;
}

export class GroupMentor {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly groupId: string,
    readonly staffMemberId: string,
    private _isPrimary: boolean,
    readonly assignedAt: Date,
    private _unassignedAt: Date | null,
    readonly createdAt: Date,
  ) {}

  static hydrate(state: GroupMentorState): GroupMentor {
    return new GroupMentor(
      state.id,
      state.kindergartenId,
      state.groupId,
      state.staffMemberId,
      state.isPrimary,
      state.assignedAt,
      state.unassignedAt,
      state.createdAt,
    );
  }

  get isPrimary(): boolean {
    return this._isPrimary;
  }
  get unassignedAt(): Date | null {
    return this._unassignedAt;
  }
  get isActive(): boolean {
    return this._unassignedAt === null;
  }

  unassign(now: Date): GroupMentor {
    if (this._unassignedAt !== null) return this;
    this._unassignedAt = now;
    return this;
  }

  toState(): GroupMentorState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      groupId: this.groupId,
      staffMemberId: this.staffMemberId,
      isPrimary: this._isPrimary,
      assignedAt: this.assignedAt,
      unassignedAt: this._unassignedAt,
      createdAt: this.createdAt,
    };
  }
}
