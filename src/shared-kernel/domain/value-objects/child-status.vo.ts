import { InvariantViolationError } from '../errors/invariant-violation.error';

export type ChildStatusValue = 'card_created' | 'active' | 'archived';

// Sealed enum-VO mirroring DB enum `child_status`. Полный набор включаем сейчас —
// B5/B21 расширят use-cases без правок VO.
export class ChildStatus {
  static readonly CARD_CREATED = new ChildStatus('card_created');
  static readonly ACTIVE = new ChildStatus('active');
  static readonly ARCHIVED = new ChildStatus('archived');

  private constructor(public readonly value: ChildStatusValue) {}

  static fromString(v: string): ChildStatus {
    switch (v) {
      case 'card_created':
        return ChildStatus.CARD_CREATED;
      case 'active':
        return ChildStatus.ACTIVE;
      case 'archived':
        return ChildStatus.ARCHIVED;
      default:
        throw new InvariantViolationError(
          `child_status must be one of card_created|active|archived, got: ${v}`,
        );
    }
  }

  equals(other: ChildStatus): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
