import { Injectable } from '@nestjs/common';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DiagnosticEntryRepository } from './diagnostic-entry.repository';
import { StaffMemberMustHaveSpecialistTypeError } from './domain/errors/staff-member-must-have-specialist-type.error';

export interface MyTodoChild {
  childId: string;
  childFullName: string;
  /** ISO `YYYY-MM-DD` of the most recent diagnostic, or null if never. */
  lastDiagnosticDate: string | null;
  /** Whole days since the last assessment in Asia/Almaty, or null if never. */
  daysSinceLast: number | null;
}

export interface MyTodosResponse {
  childrenNeedingDiagnostic: MyTodoChild[];
}

const ALMATY_TZ = 'Asia/Almaty';

/** Format a `Date` as `YYYY-MM-DD` using the Asia/Almaty civil calendar. */
function dateOnlyAlmaty(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ALMATY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Returns the date 6 calendar months before `today` in the kg timezone.
 * Used as the staleness cutoff: a child is "needs diagnostic" iff their
 * latest entry's `assessment_date` is older than `today - 6 months`, OR
 * they have never been assessed.
 */
function sixMonthsAgoAlmaty(today: Date): Date {
  const todayStr = dateOnlyAlmaty(today);
  // Parse the YYYY-MM-DD components and decrement the month by 6.
  const [yy, mm, dd] = todayStr.split('-').map((s) => parseInt(s, 10));
  const newMonth = mm - 6;
  const date = new Date(Date.UTC(yy, newMonth - 1, dd));
  return date;
}

/** Whole days between two YYYY-MM-DD calendar dates. */
function diffDaysAlmaty(later: Date, earlier: Date): number {
  const a = new Date(`${dateOnlyAlmaty(later)}T00:00:00.000Z`).getTime();
  const b = new Date(`${dateOnlyAlmaty(earlier)}T00:00:00.000Z`).getTime();
  return Math.floor((a - b) / 86_400_000);
}

@Injectable()
export class MyTodosService {
  constructor(
    private readonly children: ChildRepository,
    private readonly entries: DiagnosticEntryRepository,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Build the staff-app digest of children whose latest diagnostic for the
   * caller's specialist_type is older than 6 months (or absent).
   *
   * Resolution rules:
   *   - non-admin caller MUST have a `specialist_type`. Otherwise → 403
   *     `staff_member_must_have_specialist_type`.
   *   - admin caller without their own `specialist_type` MAY pass
   *     `requestedSpecialistType=` to override; otherwise → 403 same.
   *   - admin caller with their own `specialist_type` defaults to that,
   *     query override wins when supplied.
   */
  async getMyTodos(
    kgId: string,
    callerSpecialistType: string | null,
    requestedSpecialistType: string | undefined,
    isAdmin: boolean,
  ): Promise<MyTodosResponse> {
    if (
      !isAdmin &&
      (callerSpecialistType === null || callerSpecialistType === '')
    ) {
      throw new StaffMemberMustHaveSpecialistTypeError();
    }
    const effectiveSpecialistType = isAdmin
      ? (requestedSpecialistType ?? callerSpecialistType ?? null)
      : callerSpecialistType;
    if (effectiveSpecialistType === null || effectiveSpecialistType === '') {
      throw new StaffMemberMustHaveSpecialistTypeError();
    }

    const today = this.clock.now();
    const cutoff = sixMonthsAgoAlmaty(today);

    const [activeChildren, latestByChild] = await Promise.all([
      this.children.listActiveLightByKg(kgId),
      this.entries.findLatestPerActiveChildBySpecialistType(
        kgId,
        effectiveSpecialistType,
      ),
    ]);

    const todos: MyTodoChild[] = [];
    for (const child of activeChildren) {
      const latest = latestByChild.get(child.id);
      const lastDate = latest?.assessmentDate ?? null;
      const daysSinceLast =
        lastDate === null ? null : diffDaysAlmaty(today, lastDate);

      const needsDiag =
        lastDate === null || dateOnlyAlmaty(lastDate) < dateOnlyAlmaty(cutoff);
      if (!needsDiag) continue;

      todos.push({
        childId: child.id,
        childFullName: child.fullName,
        lastDiagnosticDate: lastDate === null ? null : dateOnlyAlmaty(lastDate),
        daysSinceLast,
      });
    }

    // Sort: never-assessed first (daysSinceLast null), then most-stale by
    // descending daysSinceLast.
    todos.sort((a, b) => {
      if (a.daysSinceLast === null && b.daysSinceLast === null) return 0;
      if (a.daysSinceLast === null) return -1;
      if (b.daysSinceLast === null) return 1;
      return b.daysSinceLast - a.daysSinceLast;
    });

    return { childrenNeedingDiagnostic: todos };
  }
}
