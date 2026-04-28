import { InvariantViolationError } from '../errors/invariant-violation.error';

const E164_RE = /^\+[1-9]\d{1,14}$/;

export class Phone {
  private constructor(private readonly value: string) {}

  static parse(raw: string): Phone {
    if (!E164_RE.test(raw)) {
      throw new InvariantViolationError('phone must be E.164');
    }
    return new Phone(raw);
  }

  toString(): string {
    return this.value;
  }

  equals(other: Phone): boolean {
    return this.value === other.value;
  }
}
