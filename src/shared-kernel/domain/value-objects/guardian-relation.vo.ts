import { InvariantViolationError } from '../errors/invariant-violation.error';

export type GuardianRelationValue = 'primary' | 'secondary' | 'nanny';

// Sealed enum-VO. DB stores `guardian_role` enum (snake_case literals — primary/secondary/nanny).
export class GuardianRelation {
  static readonly PRIMARY = new GuardianRelation('primary');
  static readonly SECONDARY = new GuardianRelation('secondary');
  static readonly NANNY = new GuardianRelation('nanny');

  private constructor(public readonly value: GuardianRelationValue) {}

  static fromString(v: string): GuardianRelation {
    switch (v) {
      case 'primary':
        return GuardianRelation.PRIMARY;
      case 'secondary':
        return GuardianRelation.SECONDARY;
      case 'nanny':
        return GuardianRelation.NANNY;
      default:
        throw new InvariantViolationError(
          `guardian_role must be one of primary|secondary|nanny, got: ${v}`,
        );
    }
  }

  equals(other: GuardianRelation): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
