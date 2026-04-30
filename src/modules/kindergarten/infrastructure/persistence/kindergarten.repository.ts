import {
  Kindergarten,
  KindergartenSettings,
} from '../../domain/entities/kindergarten.entity';

export interface KindergartenCreateInput {
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  plan: string;
  settings: KindergartenSettings;
}

export interface KindergartenFilters {
  plan?: string;
  isActive?: boolean;
  archived?: boolean;
  nameSearch?: string;
  limit?: number;
  offset?: number;
}

export interface KindergartenListResult {
  items: Kindergarten[];
  total: number;
  limit: number;
  offset: number;
}

export interface KindergartenUpdateInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  plan?: string;
  settings?: KindergartenSettings;
  isActive?: boolean;
  archivedAt?: Date | null;
}

/**
 * Port over the kindergartens table. Implementations are tenant-aware via
 * `tenantStorage` — readers transparently use the request's transactional
 * EntityManager so RLS GUCs apply, while SuperAdmin paths set
 * `bypass_rls=true` upstream.
 */
export abstract class KindergartenRepository {
  abstract create(input: KindergartenCreateInput): Promise<Kindergarten>;
  abstract findById(id: string): Promise<Kindergarten | null>;
  abstract findBySlug(slug: string): Promise<Kindergarten | null>;
  abstract findAll(
    filters: KindergartenFilters,
  ): Promise<KindergartenListResult>;
  /**
   * Returns every non-archived, active kindergarten in the system. Caller is
   * expected to be running with `bypass_rls=true` (super-admin scope or a
   * cron-process tx that explicitly sets the GUC) — RLS would otherwise hide
   * every row that does not match the tenant scope. Used by T5 weekly
   * auto-copy cron.
   */
  abstract listActive(): Promise<Kindergarten[]>;
  abstract update(
    id: string,
    changes: KindergartenUpdateInput,
  ): Promise<Kindergarten>;
}
