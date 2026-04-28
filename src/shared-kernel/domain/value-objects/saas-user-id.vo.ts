import { InvariantViolationError } from '../errors/invariant-violation.error';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SaasUserId = string & { readonly __brand: 'SaasUserId' };

export const SaasUserId = {
  parse(value: string): SaasUserId {
    if (!UUID_RE.test(value)) {
      throw new InvariantViolationError('saas_user_id must be UUID');
    }
    return value as SaasUserId;
  },
};
