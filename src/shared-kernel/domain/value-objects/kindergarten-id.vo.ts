import { InvariantViolationError } from '../errors/invariant-violation.error';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KindergartenId = string & { readonly __brand: 'KindergartenId' };

export const KindergartenId = {
  parse(value: string): KindergartenId {
    if (!UUID_RE.test(value)) {
      throw new InvariantViolationError('kindergarten_id must be UUID');
    }
    return value as KindergartenId;
  },
};
