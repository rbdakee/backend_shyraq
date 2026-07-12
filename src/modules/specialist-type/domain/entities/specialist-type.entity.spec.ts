import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { SpecialistType } from './specialist-type.entity';
import { SpecialistTypeSystemImmutableError } from '../errors/specialist-type-system-immutable.error';

const NOW = new Date('2026-07-10T10:00:00.000Z');

function create(
  overrides: Partial<Parameters<typeof SpecialistType.create>[0]> = {},
): SpecialistType {
  return SpecialistType.create({
    id: 'st-1',
    kindergartenId: 'kg-1',
    code: 'art_therapist',
    nameI18n: { ru: 'Арт-терапевт', kk: 'Арт-терапевт' },
    now: NOW,
    ...overrides,
  });
}

describe('SpecialistType domain', () => {
  it('creates with a normalised code + defaults (isSystem=false, isActive=true)', () => {
    const st = create({ code: '  ART_Therapist ' as unknown as string });
    expect(st.code).toBe('art_therapist');
    expect(st.isSystem).toBe(false);
    expect(st.isActive).toBe(true);
    expect(st.sortOrder).toBe(0);
  });

  it('rejects an invalid code shape', () => {
    expect(() => create({ code: '1bad' })).toThrow(InvariantViolationError);
    expect(() => create({ code: 'x' })).toThrow(InvariantViolationError);
    expect(() => create({ code: 'Bad-Dash' })).toThrow(InvariantViolationError);
  });

  it('requires a non-empty ru or kk label', () => {
    expect(() => create({ nameI18n: { ru: '', kk: '   ' } as never })).toThrow(
      InvariantViolationError,
    );
    expect(() => create({ nameI18n: { en: 'Art' } as never })).toThrow(
      InvariantViolationError,
    );
    // kk-only is accepted
    expect(create({ nameI18n: { kk: 'Логопед' } as never }).nameI18n).toEqual({
      kk: 'Логопед',
    });
  });

  it('applyPatch updates name/isActive/sortOrder and bumps updatedAt', () => {
    const st = create();
    const later = new Date('2026-07-11T10:00:00.000Z');
    st.applyPatch(
      {
        nameI18n: { ru: 'Психолог', kk: 'Психолог' },
        isActive: false,
        sortOrder: 7,
      },
      later,
    );
    expect(st.nameI18n).toEqual({ ru: 'Психолог', kk: 'Психолог' });
    expect(st.isActive).toBe(false);
    expect(st.sortOrder).toBe(7);
    expect(st.updatedAt).toEqual(later);
  });

  it('assertDeletable throws for system rows, passes for custom rows', () => {
    expect(() => create({ isSystem: true }).assertDeletable()).toThrow(
      SpecialistTypeSystemImmutableError,
    );
    expect(() => create({ isSystem: false }).assertDeletable()).not.toThrow();
  });

  it('toState/hydrate round-trips', () => {
    const st = create({ isSystem: true, sortOrder: 3 });
    const round = SpecialistType.hydrate(st.toState());
    expect(round.toState()).toEqual(st.toState());
  });
});
