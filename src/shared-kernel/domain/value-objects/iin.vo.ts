import { InvariantViolationError } from '../errors/invariant-violation.error';

const IIN_RE = /^\d{12}$/;

export class Iin {
  private constructor(private readonly value: string) {}

  static parse(raw: string): Iin {
    if (!IIN_RE.test(raw)) {
      throw new InvariantViolationError('iin must be 12 digits');
    }
    return new Iin(raw);
  }

  toString(): string {
    return this.value;
  }

  equals(other: Iin): boolean {
    return this.value === other.value;
  }
}
