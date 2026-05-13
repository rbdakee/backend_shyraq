import {
  DiagnosticTemplate,
  DiagnosticTemplateState,
} from './diagnostic-template.entity';
import { TemplateSchema } from '../schema-validators';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { DiagnosticTemplateSchemaInvalidError } from '../errors/diagnostic-template-schema-invalid.error';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

const minimalSchema: TemplateSchema = {
  sections: [
    {
      title: 'Speech',
      fields: [
        {
          key: 'articulation',
          label: 'Articulation',
          type: 'text',
          required: true,
        },
      ],
    },
  ],
};

const allTypesSchema: TemplateSchema = {
  sections: [
    {
      title: 'Mixed',
      fields: [
        { key: 'note', label: 'Note', type: 'text', required: false },
        {
          key: 'age_months',
          label: 'Age (months)',
          type: 'number',
          required: true,
          min: 12,
          max: 84,
        },
        {
          key: 'is_verbal',
          label: 'Is Verbal',
          type: 'boolean',
          required: true,
        },
        {
          key: 'mood',
          label: 'Mood',
          type: 'select',
          required: true,
          options: ['happy', 'sad', 'neutral'],
        },
        {
          key: 'tags',
          label: 'Tags',
          type: 'multiselect',
          required: false,
          options: ['active', 'shy'],
        },
        {
          key: 'observed_at',
          label: 'Observed at',
          type: 'date',
          required: false,
        },
        {
          key: 'engagement',
          label: 'Engagement',
          type: 'scale',
          required: true,
          min: 1,
          max: 5,
        },
      ],
    },
  ],
};

function makeState(
  overrides: Partial<DiagnosticTemplateState> = {},
): DiagnosticTemplateState {
  return {
    id: 'tpl-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    specialistType: 'speech_therapist',
    name: 'Speech Assessment v1',
    description: 'Default speech assessment template',
    version: 1,
    rowVersion: 1,
    isActive: true,
    schema: minimalSchema,
    createdBy: 'staff-uuid-0001',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('DiagnosticTemplate domain entity', () => {
  it('constructs with a valid minimal schema (happy path)', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    expect(tpl.name).toBe('Speech Assessment v1');
    expect(tpl.version).toBe(1);
    expect(tpl.isActive).toBe(true);
  });

  it('constructs with a schema using all 7 field types', () => {
    const tpl = DiagnosticTemplate.fromState(
      makeState({ schema: allTypesSchema }),
    );
    expect(tpl.schema.sections[0].fields.length).toBe(7);
  });

  it('throws when name is empty', () => {
    expect(() => DiagnosticTemplate.fromState(makeState({ name: '' }))).toThrow(
      InvariantViolationError,
    );
  });

  it('throws when name is whitespace only', () => {
    expect(() =>
      DiagnosticTemplate.fromState(makeState({ name: '   ' })),
    ).toThrow(InvariantViolationError);
  });

  it('throws when specialistType is empty', () => {
    expect(() =>
      DiagnosticTemplate.fromState(makeState({ specialistType: '' })),
    ).toThrow(InvariantViolationError);
  });

  it('throws when version is 0', () => {
    expect(() =>
      DiagnosticTemplate.fromState(makeState({ version: 0 })),
    ).toThrow(InvariantViolationError);
  });

  it('throws when rowVersion is 0', () => {
    // Row-version invariant: must be a positive integer (matches DB
    // DEFAULT 1 + the conditional UPDATE's row-version arithmetic).
    expect(() =>
      DiagnosticTemplate.fromState(makeState({ rowVersion: 0 })),
    ).toThrow(/invalid_row_version/);
  });

  it('throws when schema is invalid', () => {
    expect(() =>
      DiagnosticTemplate.fromState(
        makeState({ schema: { sections: [] } as unknown as TemplateSchema }),
      ),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('deactivate flips isActive=false and advances updatedAt', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    const next = tpl.deactivate(LATER);
    expect(next.isActive).toBe(false);
    expect(next.updatedAt).toBe(LATER);
    // original instance unchanged
    expect(tpl.isActive).toBe(true);
    expect(tpl.updatedAt).toBe(NOW);
  });

  it('deactivate twice throws already_inactive', () => {
    const tpl = DiagnosticTemplate.fromState(makeState({ isActive: false }));
    expect(() => tpl.deactivate(LATER)).toThrow(InvariantViolationError);
    expect(() => tpl.deactivate(LATER)).toThrow(/already_inactive/);
  });

  it('incrementVersion bumps version even if shape is the same', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    const next = tpl.incrementVersion(minimalSchema, LATER);
    expect(next.version).toBe(2);
  });

  it('incrementVersion validates the new schema and throws if invalid', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    expect(() =>
      tpl.incrementVersion(
        { sections: [] } as unknown as TemplateSchema,
        LATER,
      ),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('update name does not bump version', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    const next = tpl.update({ name: 'New name' }, LATER);
    expect(next.version).toBe(1);
    expect(next.name).toBe('New name');
    expect(next.updatedAt).toBe(LATER);
  });

  it('update description does not bump version', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    const next = tpl.update({ description: 'Brand new description' }, LATER);
    expect(next.version).toBe(1);
    expect(next.description).toBe('Brand new description');
  });

  it('update with structurally different schema bumps version', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    const next = tpl.update({ schema: allTypesSchema }, LATER);
    expect(next.version).toBe(2);
    expect(next.schema).toBe(allTypesSchema);
  });

  it('update with deep-equal schema does NOT bump version', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    // structurally identical clone
    const cloned: TemplateSchema = JSON.parse(JSON.stringify(minimalSchema));
    const next = tpl.update({ schema: cloned }, LATER);
    expect(next.version).toBe(1);
  });

  it('update with invalid schema throws', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    expect(() =>
      tpl.update(
        { schema: { sections: [] } as unknown as TemplateSchema },
        LATER,
      ),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('update with empty name throws', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    expect(() => tpl.update({ name: '' }, LATER)).toThrow(
      InvariantViolationError,
    );
  });

  it('toState/fromState round-trip preserves all fields', () => {
    const original = DiagnosticTemplate.fromState(makeState());
    const state = original.toState();
    const restored = DiagnosticTemplate.fromState(state);
    expect(restored.toState()).toEqual(original.toState());
  });

  it('inactive template can still be loaded from state', () => {
    const tpl = DiagnosticTemplate.fromState(makeState({ isActive: false }));
    expect(tpl.isActive).toBe(false);
    expect(tpl.name).toBe('Speech Assessment v1');
  });

  it('updatedAt advances on every mutation', () => {
    const tpl = DiagnosticTemplate.fromState(makeState());
    const t1 = tpl.update({ name: 'B' }, LATER);
    expect(t1.updatedAt).toBe(LATER);
    const EVEN_LATER = new Date(LATER.getTime() + 60000);
    const t2 = t1.deactivate(EVEN_LATER);
    expect(t2.updatedAt).toBe(EVEN_LATER);
  });
});
