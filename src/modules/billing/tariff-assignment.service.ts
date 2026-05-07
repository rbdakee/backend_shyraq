import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TariffAssignment } from './domain/entities/tariff-assignment.entity';
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffAssignmentOverlapError } from './domain/errors/tariff-assignment-overlap.error';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  ListTariffAssignmentsFilter,
  TariffAssignmentRepository,
  UpdateTariffAssignmentPatch,
} from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';

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
    private readonly tariffPlans: TariffPlanRepository,
  ) {}

  async assign(
    kindergartenId: string,
    input: AssignTariffInput,
  ): Promise<TariffAssignment> {
    // T11 H8: explicit cross-tenant guard. PG FK constraints bypass RLS,
    // so without an explicit lookup an admin in kg_A could attach a known
    // tariff_plan UUID from kg_B (the FK to tariff_plans(id) does not include
    // kindergarten_id). The repo's `findById` is RLS-scoped to the caller's
    // kg, so a cross-tenant id returns null → TariffPlanNotFoundError.
    const plan = await this.tariffPlans.findById(
      kindergartenId,
      input.tariffPlanId,
    );
    if (!plan) {
      throw new TariffPlanNotFoundError(input.tariffPlanId);
    }

    // T11 H3: serialise concurrent assigns for the same (kg, child).
    // Without the lock two admins both pass `existsOverlap` and both insert.
    await this.assignments.acquireAssignChildAdvisoryLock(
      kindergartenId,
      input.childId,
    );

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
    // T11 H8: if the caller is changing tariffPlanId, validate it belongs
    // to the caller's kg before persisting (defence-in-depth against the
    // FK-bypass-RLS pattern; RLS scope filters the SELECT).
    if (
      patch.tariffPlanId !== undefined &&
      patch.tariffPlanId !== existing.tariffPlanId
    ) {
      const plan = await this.tariffPlans.findById(
        kindergartenId,
        patch.tariffPlanId,
      );
      if (!plan) {
        throw new TariffPlanNotFoundError(patch.tariffPlanId);
      }
    }
    if (patch.validFrom !== undefined || patch.validUntil !== undefined) {
      // T11 H3: under the per-child advisory lock so the new window does
      // not race with a parallel assign() for the same child.
      await this.assignments.acquireAssignChildAdvisoryLock(
        kindergartenId,
        existing.childId,
      );
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
