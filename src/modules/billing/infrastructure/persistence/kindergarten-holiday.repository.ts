import { KindergartenHoliday } from '../../domain/entities/kindergarten-holiday.entity';

export interface CreateKindergartenHolidayInput {
  kindergartenId: string;
  date: Date;
  name: Record<string, string>;
  isBillable: boolean;
}

export interface UpdateKindergartenHolidayPatch {
  date?: Date;
  name?: Record<string, string>;
  isBillable?: boolean;
}

export interface ListKindergartenHolidaysFilter {
  /** ISO date `YYYY-MM-DD` inclusive. */
  fromDate?: string;
  /** ISO date `YYYY-MM-DD` inclusive. */
  toDate?: string;
  isBillable?: boolean;
}

/**
 * Persistence port for `kindergarten_holidays`. Maps the
 * `uq_kindergarten_holidays_kg_date` UNIQUE violation (PG SQLSTATE 23505)
 * to `KindergartenHolidayAlreadyExistsError` in the relational impl.
 */
export abstract class KindergartenHolidayRepository {
  abstract create(
    input: CreateKindergartenHolidayInput,
  ): Promise<KindergartenHoliday>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateKindergartenHolidayPatch,
    now: Date,
  ): Promise<KindergartenHoliday | null>;

  abstract delete(kindergartenId: string, id: string): Promise<void>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<KindergartenHoliday | null>;

  abstract list(
    kindergartenId: string,
    filter?: ListKindergartenHolidaysFilter,
  ): Promise<KindergartenHoliday[]>;

  /**
   * Counts holidays in the half-open period `[periodStart, periodEnd]`
   * (inclusive both ends — both columns are `date`) whose `is_billable=false`.
   * Used for pro-rata discount calculation in monthly invoice generation.
   */
  abstract countNonBillableInRange(
    kindergartenId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number>;
}
