import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { SpecialistType } from './domain/entities/specialist-type.entity';
import { SpecialistTypeCodeTakenError } from './domain/errors/specialist-type-code-taken.error';
import { SpecialistTypeInUseError } from './domain/errors/specialist-type-in-use.error';
import { SpecialistTypeNotFoundError } from './domain/errors/specialist-type-not-found.error';
import { SpecialistTypeSystemImmutableError } from './domain/errors/specialist-type-system-immutable.error';
import { SYSTEM_SPECIALIST_TYPES } from './domain/system-defaults';
import {
  ListSpecialistTypesFilter,
  SpecialistTypeRepository,
  SpecialistTypeUsage,
} from './infrastructure/persistence/specialist-type.repository';
import { SpecialistTypeService } from './specialist-type.service';

const KG = 'kg-1';
const NOW = new Date('2026-07-10T10:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

class FakeRepo extends SpecialistTypeRepository {
  rows: SpecialistType[] = [];
  usage: SpecialistTypeUsage = { staffMembers: 0, diagnosticTemplates: 0 };

  create(entity: SpecialistType): Promise<SpecialistType> {
    if (
      this.rows.some(
        (r) =>
          r.kindergartenId === entity.kindergartenId && r.code === entity.code,
      )
    ) {
      throw new SpecialistTypeCodeTakenError(entity.code);
    }
    this.rows.push(entity);
    return Promise.resolve(entity);
  }
  save(entity: SpecialistType): Promise<SpecialistType> {
    this.rows = this.rows.map((r) => (r.id === entity.id ? entity : r));
    return Promise.resolve(entity);
  }
  findById(kg: string, id: string): Promise<SpecialistType | null> {
    return Promise.resolve(
      this.rows.find((r) => r.kindergartenId === kg && r.id === id) ?? null,
    );
  }
  findByCode(kg: string, code: string): Promise<SpecialistType | null> {
    return Promise.resolve(
      this.rows.find((r) => r.kindergartenId === kg && r.code === code) ?? null,
    );
  }
  existsActiveByCode(kg: string, code: string): Promise<boolean> {
    return Promise.resolve(
      this.rows.some(
        (r) => r.kindergartenId === kg && r.code === code && r.isActive,
      ),
    );
  }
  list(
    kg: string,
    filter?: ListSpecialistTypesFilter,
  ): Promise<SpecialistType[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.kindergartenId === kg)
        .filter((r) => (filter?.includeInactive ? true : r.isActive)),
    );
  }
  delete(kg: string, id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.kindergartenId === kg && r.id === id),
    );
    return Promise.resolve(this.rows.length < before);
  }
  countUsage(): Promise<SpecialistTypeUsage> {
    return Promise.resolve(this.usage);
  }
  seedSystemDefaults(kg: string): Promise<void> {
    SYSTEM_SPECIALIST_TYPES.forEach((seed, index) => {
      if (
        !this.rows.some((r) => r.kindergartenId === kg && r.code === seed.code)
      ) {
        this.rows.push(
          SpecialistType.create({
            id: `sys-${seed.code}`,
            kindergartenId: kg,
            code: seed.code,
            nameI18n: seed.nameI18n,
            isSystem: true,
            sortOrder: index,
            now: NOW,
          }),
        );
      }
    });
    return Promise.resolve();
  }
}

function build(): { service: SpecialistTypeService; repo: FakeRepo } {
  const repo = new FakeRepo();
  return { service: new SpecialistTypeService(repo, new FixedClock()), repo };
}

describe('SpecialistTypeService', () => {
  describe('create', () => {
    it('creates a custom (non-system) row', async () => {
      const { service } = build();
      const st = await service.create(KG, {
        code: 'art_therapist',
        nameI18n: { ru: 'Арт-терапевт', kk: 'Арт-терапевт' },
      });
      expect(st.code).toBe('art_therapist');
      expect(st.isSystem).toBe(false);
      expect(st.sortOrder).toBe(100);
    });

    it('rejects a duplicate code with specialist_type_code_taken', async () => {
      const { service } = build();
      await service.create(KG, {
        code: 'art_therapist',
        nameI18n: { ru: 'Арт', kk: 'Арт' },
      });
      await expect(
        service.create(KG, {
          code: 'art_therapist',
          nameI18n: { ru: 'X', kk: 'X' },
        }),
      ).rejects.toBeInstanceOf(SpecialistTypeCodeTakenError);
    });
  });

  describe('update', () => {
    it('renames an existing row', async () => {
      const { service } = build();
      const st = await service.create(KG, {
        code: 'art_therapist',
        nameI18n: { ru: 'Арт', kk: 'Арт' },
      });
      const updated = await service.update(KG, st.id, {
        nameI18n: { ru: 'Нейропсихолог', kk: 'Нейропсихолог' },
        isActive: false,
      });
      expect(updated.nameI18n).toEqual({
        ru: 'Нейропсихолог',
        kk: 'Нейропсихолог',
      });
      expect(updated.isActive).toBe(false);
    });

    it('throws specialist_type_not_found for an unknown id', async () => {
      const { service } = build();
      await expect(
        service.update(KG, 'missing', { isActive: false }),
      ).rejects.toBeInstanceOf(SpecialistTypeNotFoundError);
    });
  });

  describe('delete', () => {
    it('blocks deleting a system row', async () => {
      const { service, repo } = build();
      await service.seedSystemDefaults(KG);
      const sys = repo.rows.find((r) => r.code === 'psychologist')!;
      await expect(service.delete(KG, sys.id)).rejects.toBeInstanceOf(
        SpecialistTypeSystemImmutableError,
      );
    });

    it('blocks deleting a code still in use, with usage counts', async () => {
      const { service, repo } = build();
      const st = await service.create(KG, {
        code: 'art_therapist',
        nameI18n: { ru: 'Арт', kk: 'Арт' },
      });
      repo.usage = { staffMembers: 2, diagnosticTemplates: 1 };
      await expect(service.delete(KG, st.id)).rejects.toMatchObject({
        code: 'specialist_type_in_use',
        details: { staff_members: 2, diagnostic_templates: 1 },
      });
      expect(SpecialistTypeInUseError).toBeDefined();
    });

    it('deletes an unused custom row', async () => {
      const { service, repo } = build();
      const st = await service.create(KG, {
        code: 'art_therapist',
        nameI18n: { ru: 'Арт', kk: 'Арт' },
      });
      await service.delete(KG, st.id);
      expect(repo.rows.find((r) => r.id === st.id)).toBeUndefined();
    });
  });

  describe('assertUsableCode', () => {
    it('passes for an active code', async () => {
      const { service } = build();
      await service.seedSystemDefaults(KG);
      await expect(
        service.assertUsableCode(KG, 'doctor_nutritionist'),
      ).resolves.toBeUndefined();
    });

    it('throws specialist_type_unknown for an unknown code', async () => {
      const { service } = build();
      await expect(
        service.assertUsableCode(KG, 'no_such_code'),
      ).rejects.toMatchObject({ code: 'specialist_type_unknown' });
    });

    it('throws for an inactive code', async () => {
      const { service, repo } = build();
      const st = await service.create(KG, {
        code: 'art_therapist',
        nameI18n: { ru: 'Арт', kk: 'Арт' },
        isActive: false,
      });
      expect(st.isActive).toBe(false);
      await expect(
        service.assertUsableCode(KG, 'art_therapist'),
      ).rejects.toBeInstanceOf(InvariantViolationError);
      expect(repo.rows).toHaveLength(1);
    });
  });

  describe('seedSystemDefaults', () => {
    it('is idempotent — re-seeding does not duplicate', async () => {
      const { service, repo } = build();
      await service.seedSystemDefaults(KG);
      await service.seedSystemDefaults(KG);
      expect(repo.rows).toHaveLength(SYSTEM_SPECIALIST_TYPES.length);
      // doctor_nutritionist is one of the six seeded system rows
      expect(repo.rows.map((r) => r.code)).toContain('doctor_nutritionist');
    });
  });
});
