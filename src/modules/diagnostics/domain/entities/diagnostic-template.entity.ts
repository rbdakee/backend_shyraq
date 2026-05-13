import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  TemplateSchema,
  validateTemplateSchemaShape,
  deepEqualJson,
} from '../schema-validators';

/**
 * `DiagnosticTemplate` — a per-kindergarten reusable schema for filling in
 * specialist-authored diagnostic entries. Bound to a `specialist_type`
 * (free-form varchar; the staff_members table defines the canonical set).
 *
 * Mutations are immutable (return-new-instance) so service-layer callers
 * can treat the aggregate as a value object inside transactions. Each
 * mutation method advances `updatedAt`.
 */
export interface DiagnosticTemplateState {
  id: string;
  kindergartenId: string;
  specialistType: string;
  name: string;
  description: string | null;
  /** Schema version — bumped only when the JSONB schema deeply differs. */
  version: number;
  /**
   * Optimistic-lock token (B22a T4). Internal — not exposed via DTO.
   * Mutated by the relational repo's conditional UPDATE; the domain
   * carries the value through so service.update() can pass the freshly
   * loaded snapshot back to the repo as `expectedRowVersion`.
   */
  rowVersion: number;
  isActive: boolean;
  schema: TemplateSchema;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiagnosticTemplateUpdatePatch {
  name?: string;
  description?: string | null;
  schema?: TemplateSchema;
}

export class DiagnosticTemplate {
  private constructor(private readonly state: DiagnosticTemplateState) {}

  static fromState(s: DiagnosticTemplateState): DiagnosticTemplate {
    DiagnosticTemplate.assertInvariants(s);
    return new DiagnosticTemplate({ ...s });
  }

  toState(): DiagnosticTemplateState {
    return { ...this.state };
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get specialistType(): string {
    return this.state.specialistType;
  }

  get name(): string {
    return this.state.name;
  }

  get description(): string | null {
    return this.state.description;
  }

  get version(): number {
    return this.state.version;
  }

  get rowVersion(): number {
    return this.state.rowVersion;
  }

  get isActive(): boolean {
    return this.state.isActive;
  }

  get schema(): TemplateSchema {
    return this.state.schema;
  }

  get createdBy(): string {
    return this.state.createdBy;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── invariants ───────────────────────────────────────────────────────────

  private static assertInvariants(s: DiagnosticTemplateState): void {
    if (typeof s.name !== 'string' || s.name.trim() === '') {
      throw new InvariantViolationError('empty_name');
    }
    if (
      typeof s.specialistType !== 'string' ||
      s.specialistType.trim() === ''
    ) {
      throw new InvariantViolationError('empty_specialist_type');
    }
    if (!Number.isInteger(s.version) || s.version < 1) {
      throw new InvariantViolationError('invalid_version');
    }
    if (!Number.isInteger(s.rowVersion) || s.rowVersion < 1) {
      throw new InvariantViolationError('invalid_row_version');
    }
    validateTemplateSchemaShape(s.schema);
  }

  // ── mutations (immutable, return new instance) ───────────────────────────

  /**
   * Returns a new instance with `isActive=false`. Throws
   * `InvariantViolationError(code='already_inactive')` if already inactive.
   */
  deactivate(now: Date): DiagnosticTemplate {
    if (!this.state.isActive) {
      throw new InvariantViolationError('already_inactive');
    }
    return new DiagnosticTemplate({
      ...this.state,
      isActive: false,
      updatedAt: now,
    });
  }

  /**
   * Returns a new instance with `schema=newSchema`, `version=version+1`.
   * Caller decides when to bump (e.g. structural-only changes still bump
   * because consumers may have cached the previous schema). Validates the
   * new schema before mutating.
   */
  incrementVersion(newSchema: TemplateSchema, now: Date): DiagnosticTemplate {
    validateTemplateSchemaShape(newSchema);
    return new DiagnosticTemplate({
      ...this.state,
      schema: newSchema,
      version: this.state.version + 1,
      updatedAt: now,
    });
  }

  /**
   * Returns a new instance with `patch` applied. If `patch.schema` is
   * provided AND deeply differs from the current schema, `version` is
   * bumped. If the patched schema is structurally identical (deep-equal),
   * `version` is preserved.
   */
  update(patch: DiagnosticTemplateUpdatePatch, now: Date): DiagnosticTemplate {
    const next: DiagnosticTemplateState = {
      ...this.state,
      updatedAt: now,
    };

    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || patch.name.trim() === '') {
        throw new InvariantViolationError('empty_name');
      }
      next.name = patch.name;
    }
    if (patch.description !== undefined) {
      next.description = patch.description;
    }
    if (patch.schema !== undefined) {
      validateTemplateSchemaShape(patch.schema);
      next.schema = patch.schema;
      if (!deepEqualJson(this.state.schema, patch.schema)) {
        next.version = this.state.version + 1;
      }
    }
    return new DiagnosticTemplate(next);
  }
}
