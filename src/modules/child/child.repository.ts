import { Child } from './domain/entities/child.entity';

export type ChildStatusFilter = 'card_created' | 'active' | 'archived';

export interface ChildListFilters {
  status?: ChildStatusFilter;
  currentGroupId?: string;
  /** Substring match against full_name OR iin (case-insensitive on full_name). */
  q?: string;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface ChildGroupHistoryRecord {
  id: string;
  childId: string;
  fromGroupId: string | null;
  toGroupId: string | null;
  transferredAt: Date;
  transferredByStaffId: string;
  reason: string | null;
}

/**
 * Port over the `children` table and its `child_group_history` audit. The
 * service layer always passes `kindergartenId` explicitly — RLS is
 * defense-in-depth, not the contract boundary.
 */
export abstract class ChildRepository {
  abstract create(child: Child): Promise<void>;
  abstract findById(kindergartenId: string, id: string): Promise<Child | null>;
  abstract findByKindergartenAndIin(
    kindergartenId: string,
    iin: string,
  ): Promise<Child | null>;
  abstract update(child: Child): Promise<void>;
  abstract list(
    kindergartenId: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>>;

  /** Used by Group module to count active children per group (capacity guard). */
  abstract countActiveByGroup(
    kindergartenId: string,
    groupId: string,
  ): Promise<number>;

  /**
   * Records a child_group_history row. Service calls this AFTER mutating
   * `child.currentGroupId` via the entity and persisting via `update()`.
   */
  abstract recordGroupTransfer(
    kindergartenId: string,
    childId: string,
    fromGroupId: string | null,
    toGroupId: string,
    transferredByStaffId: string,
    reason: string | null,
    at: Date,
  ): Promise<void>;

  abstract listGroupHistory(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGroupHistoryRecord[]>;
}
