import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { KindergartenHoliday } from './domain/entities/kindergarten-holiday.entity';
import {
  CreateKindergartenHolidayInput,
  KindergartenHolidayRepository,
  ListKindergartenHolidaysFilter,
  UpdateKindergartenHolidayPatch,
} from './infrastructure/persistence/kindergarten-holiday.repository';
import { NotFoundError } from '@/shared-kernel/domain/errors';

export interface CreateHolidayInput {
  date: Date;
  name: Record<string, string>;
  isBillable?: boolean;
}

export type UpdateHolidayInput = UpdateKindergartenHolidayPatch;

/**
 * HolidayService — admin CRUD over per-kindergarten holiday calendar.
 * Used by `InvoiceService` for pro-rata calculation in
 * `generateMonthly`.
 */
@Injectable()
export class HolidayService {
  constructor(
    private readonly holidays: KindergartenHolidayRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async create(
    kindergartenId: string,
    input: CreateHolidayInput,
  ): Promise<KindergartenHoliday> {
    const dto: CreateKindergartenHolidayInput = {
      kindergartenId,
      date: input.date,
      name: input.name,
      isBillable: input.isBillable ?? false,
    };
    return this.holidays.create(dto);
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateHolidayInput,
  ): Promise<KindergartenHoliday> {
    const updated = await this.holidays.update(
      kindergartenId,
      id,
      patch,
      this.clock.now(),
    );
    if (!updated) {
      throw new NotFoundError('kindergarten_holiday', id);
    }
    return updated;
  }

  async delete(kindergartenId: string, id: string): Promise<void> {
    const existing = await this.holidays.findById(kindergartenId, id);
    if (!existing) {
      throw new NotFoundError('kindergarten_holiday', id);
    }
    await this.holidays.delete(kindergartenId, id);
  }

  async list(
    kindergartenId: string,
    filter?: ListKindergartenHolidaysFilter,
  ): Promise<KindergartenHoliday[]> {
    return this.holidays.list(kindergartenId, filter);
  }

  async get(kindergartenId: string, id: string): Promise<KindergartenHoliday> {
    const h = await this.holidays.findById(kindergartenId, id);
    if (!h) {
      throw new NotFoundError('kindergarten_holiday', id);
    }
    return h;
  }

  async countNonBillableInRange(
    kindergartenId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    return this.holidays.countNonBillableInRange(
      kindergartenId,
      periodStart,
      periodEnd,
    );
  }
}
