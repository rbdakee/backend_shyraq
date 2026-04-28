import {
  Kindergarten,
  KindergartenSettings,
} from './domain/entities/kindergarten.entity';

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
  abstract update(
    id: string,
    changes: KindergartenUpdateInput,
  ): Promise<Kindergarten>;
}
