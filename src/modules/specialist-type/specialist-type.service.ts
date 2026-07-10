import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { SpecialistType } from './domain/entities/specialist-type.entity';
import { SpecialistTypeNotFoundError } from './domain/errors/specialist-type-not-found.error';
import { SpecialistTypeCodeTakenError } from './domain/errors/specialist-type-code-taken.error';
import { SpecialistTypeInUseError } from './domain/errors/specialist-type-in-use.error';
import type { SpecialistTypeLabels } from './domain/system-defaults';
import {
  ListSpecialistTypesFilter,
  SpecialistTypeRepository,
} from './infrastructure/persistence/specialist-type.repository';

export interface CreateSpecialistTypeInput {
  code: string;
  nameI18n: SpecialistTypeLabels;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateSpecialistTypeInput {
  nameI18n?: SpecialistTypeLabels;
  isActive?: boolean;
  sortOrder?: number;
}

/** Custom (non-system) rows default to this order — after the 6 system rows. */
const DEFAULT_CUSTOM_SORT_ORDER = 100;

/**
 * SpecialistTypeService — admin CRUD over the per-kindergarten specialist-type
 * directory, plus `assertUsableCode` which staff / diagnostics call to validate
 * a referenced `specialist_type` against the ACTIVE directory (the directory is
 * the authority; those tables hold soft references).
 *
 * Runs inside the request-scoped tenant TX from `TenantContextInterceptor`; the
 * repository picks up the request EntityManager from `tenantStorage`, so the
 * service stays free of typeorm imports.
 */
@Injectable()
export class SpecialistTypeService {
  constructor(
    private readonly repo: SpecialistTypeRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  list(
    kindergartenId: string,
    filter?: ListSpecialistTypesFilter,
  ): Promise<SpecialistType[]> {
    return this.repo.list(kindergartenId, filter);
  }

  async getById(kindergartenId: string, id: string): Promise<SpecialistType> {
    const row = await this.repo.findById(kindergartenId, id);
    if (!row) throw new SpecialistTypeNotFoundError(id);
    return row;
  }

  async create(
    kindergartenId: string,
    input: CreateSpecialistTypeInput,
  ): Promise<SpecialistType> {
    const now = this.clock.now();
    const entity = SpecialistType.create({
      id: randomUUID(),
      kindergartenId,
      code: input.code,
      nameI18n: input.nameI18n,
      isSystem: false,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? DEFAULT_CUSTOM_SORT_ORDER,
      now,
    });
    // Friendly pre-check; the repo also maps the unique-index 23505 to the same
    // error so a concurrent insert still surfaces `specialist_type_code_taken`.
    const clash = await this.repo.findByCode(kindergartenId, entity.code);
    if (clash) throw new SpecialistTypeCodeTakenError(entity.code);
    return this.repo.create(entity);
  }

  async update(
    kindergartenId: string,
    id: string,
    input: UpdateSpecialistTypeInput,
  ): Promise<SpecialistType> {
    const existing = await this.repo.findById(kindergartenId, id);
    if (!existing) throw new SpecialistTypeNotFoundError(id);
    existing.applyPatch(
      {
        ...(input.nameI18n !== undefined ? { nameI18n: input.nameI18n } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined
          ? { sortOrder: input.sortOrder }
          : {}),
      },
      this.clock.now(),
    );
    return this.repo.save(existing);
  }

  /**
   * Hard delete. System rows are permanent (`assertDeletable` → 409). A code
   * still referenced by staff / diagnostic templates is blocked with
   * `specialist_type_in_use` (409, with usage counts) — deactivate instead.
   */
  async delete(kindergartenId: string, id: string): Promise<void> {
    const existing = await this.repo.findById(kindergartenId, id);
    if (!existing) throw new SpecialistTypeNotFoundError(id);
    existing.assertDeletable();
    const usage = await this.repo.countUsage(kindergartenId, existing.code);
    if (usage.staffMembers > 0 || usage.diagnosticTemplates > 0) {
      throw new SpecialistTypeInUseError(
        existing.code,
        usage.staffMembers,
        usage.diagnosticTemplates,
      );
    }
    await this.repo.delete(kindergartenId, id);
  }

  /**
   * Validation entrypoint for staff / diagnostics. Throws
   * `InvariantViolationError('specialist_type_unknown')` (HTTP 400) when the
   * code is not an ACTIVE row in this kindergarten's directory.
   */
  async assertUsableCode(kindergartenId: string, code: string): Promise<void> {
    const ok = await this.repo.existsActiveByCode(kindergartenId, code);
    if (!ok) {
      throw new InvariantViolationError('specialist_type_unknown');
    }
  }

  /** New-kindergarten seed-hook — idempotent. */
  seedSystemDefaults(kindergartenId: string): Promise<void> {
    return this.repo.seedSystemDefaults(kindergartenId);
  }
}
