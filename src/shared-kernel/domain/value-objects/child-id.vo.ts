import { InvariantViolationError } from '../errors/invariant-violation.error';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChildId = string & { readonly __brand: 'ChildId' };

export const ChildId = {
  parse(value: string): ChildId {
    if (!UUID_RE.test(value)) {
      throw new InvariantViolationError('child_id must be UUID');
    }
    return value as ChildId;
  },
};
