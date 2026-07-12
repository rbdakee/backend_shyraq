import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { SpecialistTypeSystemImmutableError } from '../errors/specialist-type-system-immutable.error';
import type { SpecialistTypeLabels } from '../system-defaults';

/**
 * `code` shape: lowercase snake, letter-led, 2–64 chars. Immutable after
 * creation — renaming a code would orphan every `staff_members` /
 * `diagnostic_templates` row that references it, so only `name_i18n`,
 * `is_active` and `sort_order` are mutable.
 */
const CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface SpecialistTypeState {
  id: string;
  kindergartenId: string;
  code: string;
  nameI18n: SpecialistTypeLabels;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpecialistTypePatch {
  nameI18n?: SpecialistTypeLabels;
  isActive?: boolean;
  sortOrder?: number;
}

/**
 * Per-kindergarten specialist-type directory row (admin-managed). The directory
 * is the AUTHORITY on which `specialist_type` codes staff/diagnostics may use;
 * those tables carry the code as a soft reference (validated at the service
 * layer, no hard FK — keeps existing rows valid + backward-compatible).
 *
 * Rich-ish aggregate: `code` shape + non-empty `name_i18n` invariants live in
 * the constructors; `is_system` rows are protected from deletion.
 */
export class SpecialistType {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly code: string,
    private _nameI18n: SpecialistTypeLabels,
    readonly isSystem: boolean,
    private _isActive: boolean,
    private _sortOrder: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static create(input: {
    id: string;
    kindergartenId: string;
    code: string;
    nameI18n: SpecialistTypeLabels;
    isSystem?: boolean;
    isActive?: boolean;
    sortOrder?: number;
    now: Date;
  }): SpecialistType {
    const code = input.code.trim().toLowerCase();
    if (!CODE_RE.test(code)) {
      throw new InvariantViolationError('specialist_type_code_invalid');
    }
    const nameI18n = SpecialistType.normaliseLabels(input.nameI18n);
    return new SpecialistType(
      input.id,
      input.kindergartenId,
      code,
      nameI18n,
      input.isSystem ?? false,
      input.isActive ?? true,
      input.sortOrder ?? 0,
      input.now,
      input.now,
    );
  }

  static hydrate(state: SpecialistTypeState): SpecialistType {
    return new SpecialistType(
      state.id,
      state.kindergartenId,
      state.code,
      state.nameI18n,
      state.isSystem,
      state.isActive,
      state.sortOrder,
      state.createdAt,
      state.updatedAt,
    );
  }

  /**
   * At least one of `ru` / `kk` must be a non-empty string. Extra locales are
   * allowed (e.g. `en`). Blank/whitespace-only values are rejected.
   */
  private static normaliseLabels(
    labels: SpecialistTypeLabels,
  ): SpecialistTypeLabels {
    if (
      labels === null ||
      typeof labels !== 'object' ||
      Array.isArray(labels)
    ) {
      throw new InvariantViolationError('specialist_type_name_required');
    }
    const out: Record<string, string> = {};
    for (const [locale, value] of Object.entries(labels)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        out[locale] = value.trim();
      }
    }
    if (
      (out.ru === undefined || out.ru.length === 0) &&
      (out.kk === undefined || out.kk.length === 0)
    ) {
      throw new InvariantViolationError('specialist_type_name_required');
    }
    return out as SpecialistTypeLabels;
  }

  get nameI18n(): SpecialistTypeLabels {
    return this._nameI18n;
  }
  get isActive(): boolean {
    return this._isActive;
  }
  get sortOrder(): number {
    return this._sortOrder;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  applyPatch(patch: SpecialistTypePatch, now: Date): SpecialistType {
    let changed = false;
    if (patch.nameI18n !== undefined) {
      this._nameI18n = SpecialistType.normaliseLabels(patch.nameI18n);
      changed = true;
    }
    if (patch.isActive !== undefined) {
      this._isActive = patch.isActive;
      changed = true;
    }
    if (patch.sortOrder !== undefined) {
      if (!Number.isInteger(patch.sortOrder)) {
        throw new InvariantViolationError('specialist_type_sort_order_invalid');
      }
      this._sortOrder = patch.sortOrder;
      changed = true;
    }
    if (changed) this._updatedAt = now;
    return this;
  }

  /**
   * Guard invoked before a hard delete. System rows are permanent — the
   * frontend should offer "deactivate" (is_active=false) instead.
   */
  assertDeletable(): void {
    if (this.isSystem) {
      throw new SpecialistTypeSystemImmutableError(this.code);
    }
  }

  toState(): SpecialistTypeState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      code: this.code,
      nameI18n: this._nameI18n,
      isSystem: this.isSystem,
      isActive: this._isActive,
      sortOrder: this._sortOrder,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
