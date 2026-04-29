import { Location } from '../../domain/entities/location.entity';

export interface CreateLocationInput {
  name: string;
  description?: string | null;
}

export interface UpdateLocationInput {
  name?: string;
  description?: string | null;
}

export interface ListLocationsFilters {
  archived?: boolean;
}

/**
 * Port over the locations table. Implementations are tenant-aware via
 * `tenantStorage` — readers transparently use the request's transactional
 * EntityManager so RLS GUCs apply.
 */
export abstract class LocationRepository {
  abstract create(
    kindergartenId: string,
    input: CreateLocationInput,
  ): Promise<Location>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<Location | null>;

  abstract list(
    kindergartenId: string,
    filters?: ListLocationsFilters,
  ): Promise<Location[]>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateLocationInput,
  ): Promise<Location | null>;

  abstract save(location: Location): Promise<Location>;
}
