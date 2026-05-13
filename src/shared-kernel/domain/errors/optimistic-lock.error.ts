import { ConflictError } from './conflict.error';

/**
 * Generic optimistic-lock conflict (HTTP 409).
 *
 * Thrown by repository `update(...)` adapters when a conditional
 * `WHERE row_version = $expected` UPDATE matches zero rows — meaning
 * another writer flipped the row between the caller's read and write.
 *
 * The client should reload the resource and retry the PATCH; no body
 * details are exposed (the row_version column is internal — see B22a T4).
 */
export class OptimisticLockError extends ConflictError {
  constructor() {
    super(
      'optimistic_lock_conflict',
      'Resource was modified by another request — reload and retry.',
    );
  }
}
