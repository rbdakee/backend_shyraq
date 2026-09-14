import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * The caller is an approved guardian of this child but does not hold
 * `view_cctv`. Nannies are denied by default (see the permission matrix in
 * `guardian-permissions.vo.ts`); a primary can grant it explicitly.
 */
export class CctvAccessDeniedError extends ForbiddenActionError {
  constructor() {
    super('cctv_access_denied', 'guardian is not allowed to view cctv');
  }
}
