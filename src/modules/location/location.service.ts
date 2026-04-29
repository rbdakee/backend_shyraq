import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Location } from './domain/entities/location.entity';
import { LocationArchivedError } from './domain/errors/location-archived.error';
import { LocationNotFoundError } from './domain/errors/location-not-found.error';
import {
  CreateLocationInput,
  ListLocationsFilters,
  LocationRepository,
  UpdateLocationInput,
} from './infrastructure/persistence/location.repository';

/**
 * LocationService — admin-scoped CRUD over kindergarten locations.
 * Mutations always thread `kindergartenId` through repo calls; the
 * `TenantContextInterceptor` adds RLS as defense-in-depth at the DB layer.
 */
@Injectable()
export class LocationService {
  constructor(
    private readonly locations: LocationRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  list(
    kindergartenId: string,
    filters?: ListLocationsFilters,
  ): Promise<Location[]> {
    return this.locations.list(kindergartenId, filters);
  }

  async getById(kindergartenId: string, id: string): Promise<Location> {
    const row = await this.locations.findById(kindergartenId, id);
    if (!row) throw new LocationNotFoundError(id);
    return row;
  }

  async create(
    kindergartenId: string,
    input: CreateLocationInput,
  ): Promise<Location> {
    return this.locations.create(kindergartenId, input);
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateLocationInput,
  ): Promise<Location> {
    const current = await this.locations.findById(kindergartenId, id);
    if (!current) throw new LocationNotFoundError(id);
    if (current.isArchived) throw new LocationArchivedError(id);
    const updated = await this.locations.update(kindergartenId, id, patch);
    if (!updated) throw new LocationNotFoundError(id);
    return updated;
  }

  async archive(kindergartenId: string, id: string): Promise<Location> {
    const current = await this.locations.findById(kindergartenId, id);
    if (!current) throw new LocationNotFoundError(id);
    if (current.isArchived) return current;
    current.archive(this.clock.now());
    return this.locations.save(current);
  }

  async restore(kindergartenId: string, id: string): Promise<Location> {
    const current = await this.locations.findById(kindergartenId, id);
    if (!current) throw new LocationNotFoundError(id);
    if (!current.isArchived) return current;
    current.restore(this.clock.now());
    return this.locations.save(current);
  }
}
