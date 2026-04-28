import { InvariantViolationError } from '../errors/invariant-violation.error';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UserId = string & { readonly __brand: 'UserId' };

export const UserId = {
  parse(value: string): UserId {
    if (!UUID_RE.test(value)) {
      throw new InvariantViolationError('user_id must be UUID');
    }
    return value as UserId;
  },
};
