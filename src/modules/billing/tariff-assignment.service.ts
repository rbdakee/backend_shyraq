import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TariffAssignment } from './domain/entities/tariff-assignment.entity';
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffAssignmentOverlapError } from './domain/errors/tariff-assignment-overlap.error';
import {
  ListTariffAssignmentsFilter,
  TariffAssignmentRepository,
  UpdateTariffAssignmentPatch,
} from './infrastructure/persistence/tariff-assignment.repository';

export interface AssignTariffInput {
  childId: string;
  tariffPlanId: string;
  customAmount?: number | null;
  customReason?: string | null;
  validFrom: Date;
  validUntil?: Date | null;
  assignedBy: string;
}

export type UpdateTariffAssignmentInput = UpdateTariffAssignmentPatch;

/**
 * TariffAssignmentService — links children to tariff plans (with optional
 * `custom_amount` override). Overlap detection is enforced via a
 * `existsOverlap` repo query because the migration did not declare a
 * UNIQUE constraint on `(child_id, valid_from)` (a window-overlap UNIQUE
 * needs an `EXCLUDE` index, deferred to a future hardening migration).
 */
@Injectable()
export class TariffAssignmentService {
  constructor(
    private readonly assignments: TariffAssignmentRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async assign(
    kindergartenId: string,
    input: AssignTariffInput,
  ): Promise<TariffAssignment> {
    const validUntil = input.validUntil ?? null;
    const overlap = await this.assignments.existsOverlap(
      kindergartenId,
      input.childId,
      input.validFrom,
      validUntil,
    );
    if (overlap) {
      throw new TariffAssignmentOverlapError(input.childId);
    }
    return this.assignments.create({
      kindergartenId,
      childId: input.childId,
      tariffPlanId: input.tariffPlanId,
      customAmount: input.customAmount ?? null,
      customReason: input.customReason ?? null,
      validFrom: input.validFrom,
      validUntil,
      assignedBy: input.assignedBy,
    });
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffAssignmentInput,
  ): Promise<TariffAssignment> {
    const existing = await this.assignments.findById(kindergartenId, id);
    if (!existing) {
      throw new TariffAssignmentNotFoundError(id);
    }
    if (patch.validFrom !== undefined || patch.validUntil !== undefined) {
      const newFrom = patch.validFrom ?? existing.validFrom;
      const newUntil =
        patch.validUntil !== undefined ? patch.validUntil : existing.validUntil;
      const overlap = await this.assignments.existsOverlap(
        kindergartenId,
        existing.childId,
        newFrom,
        newUntil,
        id,
      );
      if (overlap) {
        throw new TariffAssignmentOverlapError(existing.childId);
      }
    }
    const updated = await this.assignments.update(
      kindergartenId,
      id,
      patch,
      this.clock.now(),
    );
    if (!updated) {
      throw new TariffAssignmentNotFoundError(id);
    }
    return updated;
  }

  async close(kindergartenId: string, id: string): Promise<TariffAssignment> {
    const existing = await this.assignments.findById(kindergartenId, id);
    if (!existing) {
      throw new TariffAssignmentNotFoundError(id);
    }
    existing.close(this.clock.now());
    return this.assignments.save(existing);
  }

  async list(
    kindergartenId: string,
    filter?: ListTariffAssignmentsFilter,
  ): Promise<TariffAssignment[]> {
    return this.assignments.list(kindergartenId, filter);
  }

  async get(kindergartenId: string, id: string): Promise<TariffAssignment> {
    const a = await this.assignments.findById(kindergartenId, id);
    if (!a) {
      throw new TariffAssignmentNotFoundError(id);
    }
    return a;
  }

  async findActiveForChild(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<TariffAssignment | null> {
    return this.assignments.findActiveForChild(kindergartenId, childId, atDate);
  }
}
