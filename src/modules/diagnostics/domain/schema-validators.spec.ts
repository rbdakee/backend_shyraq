import {
  TemplateSchema,
  validateTemplateSchemaShape,
  validateEntryData,
  deepEqualJson,
} from './schema-validators';
import { DiagnosticTemplateSchemaInvalidError } from './errors/diagnostic-template-schema-invalid.error';
import { DiagnosticEntryDataInvalidError } from './errors/diagnostic-entry-data-invalid.error';

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
          options: ['active', 'shy', 'curious'],
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

describe('validateTemplateSchemaShape', () => {
  it('accepts a minimal valid schema', () => {
    expect(() => validateTemplateSchemaShape(minimalSchema)).not.toThrow();
  });

  it('accepts a schema using all 7 field types', () => {
    expect(() => validateTemplateSchemaShape(allTypesSchema)).not.toThrow();
  });

  it('throws when schema is null', () => {
    expect(() => validateTemplateSchemaShape(null)).toThrow(
      DiagnosticTemplateSchemaInvalidError,
    );
  });

  it('throws when sections key is missing', () => {
    expect(() => validateTemplateSchemaShape({})).toThrow(
      DiagnosticTemplateSchemaInvalidError,
    );
  });

  it('throws when sections is empty array', () => {
    expect(() => validateTemplateSchemaShape({ sections: [] })).toThrow(
      DiagnosticTemplateSchemaInvalidError,
    );
  });

  it('throws when section has no title', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: '',
            fields: [{ key: 'x', label: 'X', type: 'text', required: false }],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when section has no fields', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [{ title: 'S', fields: [] }],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when field is missing key', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [{ label: 'X', type: 'text', required: false }],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when field key has uppercase chars', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [
              { key: 'BadKey', label: 'X', type: 'text', required: false },
            ],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws on duplicate field keys across sections', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'A',
            fields: [{ key: 'dup', label: 'A', type: 'text', required: false }],
          },
          {
            title: 'B',
            fields: [{ key: 'dup', label: 'B', type: 'text', required: false }],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when field is missing type', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          { title: 'S', fields: [{ key: 'x', label: 'X', required: false }] },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws on unknown field type', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [{ key: 'x', label: 'X', type: 'foo', required: false }],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when select has no options', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [{ key: 'x', label: 'X', type: 'select', required: false }],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when select has only one option', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'x',
                label: 'X',
                type: 'select',
                required: false,
                options: ['only'],
              },
            ],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('throws when number field has min >= max', () => {
    expect(() =>
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'x',
                label: 'X',
                type: 'number',
                required: false,
                min: 10,
                max: 5,
              },
            ],
          },
        ],
      }),
    ).toThrow(DiagnosticTemplateSchemaInvalidError);
  });

  it('attaches a path detail describing the offending field', () => {
    try {
      validateTemplateSchemaShape({
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'x',
                label: 'X',
                type: 'select',
                required: false,
                options: ['only'],
              },
            ],
          },
        ],
      });
      fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DiagnosticTemplateSchemaInvalidError);
      const err = e as DiagnosticTemplateSchemaInvalidError;
      expect(err.details.path).toContain('options');
      expect(err.details.message).toMatch(/select/);
    }
  });
});

describe('validateEntryData', () => {
  it('accepts data with all required fields valid', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 36,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
      }),
    ).not.toThrow();
  });

  it('accepts data with optional fields skipped', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: false,
        mood: 'neutral',
        engagement: 2,
      }),
    ).not.toThrow();
  });

  it('throws when required text field is missing', () => {
    expect(() => validateEntryData(minimalSchema, {})).toThrow(
      DiagnosticEntryDataInvalidError,
    );
  });

  it('throws when required text field is empty', () => {
    expect(() =>
      validateEntryData(minimalSchema, { articulation: '' }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when required text field is whitespace only', () => {
    expect(() =>
      validateEntryData(minimalSchema, { articulation: '   \t' }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('accepts an empty string for an OPTIONAL text field', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        note: '',
        age_months: 24,
        is_verbal: false,
        mood: 'neutral',
        engagement: 2,
      }),
    ).not.toThrow();
  });

  it('throws when number field is below min', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 1,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when number field is above max', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 999,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when number field is wrong type', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 'thirty-six',
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when boolean field receives a string', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: 'yes',
        mood: 'happy',
        engagement: 3,
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when select value is not in options', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'ecstatic',
        engagement: 3,
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when multiselect contains an unknown value', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
        tags: ['active', 'forbidden_tag'],
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('throws when REQUIRED multiselect is empty array', () => {
    const requiredMultiSchema: TemplateSchema = {
      sections: [
        {
          title: 'S',
          fields: [
            {
              key: 'tags',
              label: 'Tags',
              type: 'multiselect',
              required: true,
              options: ['a', 'b'],
            },
          ],
        },
      ],
    };
    expect(() => validateEntryData(requiredMultiSchema, { tags: [] })).toThrow(
      DiagnosticEntryDataInvalidError,
    );
  });

  it('accepts empty array for OPTIONAL multiselect', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
        tags: [],
      }),
    ).not.toThrow();
  });

  it('throws when date field is malformed', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
        observed_at: '01/05/2026',
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('accepts a date in YYYY-MM-DD format', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
        observed_at: '2026-05-07',
      }),
    ).not.toThrow();
  });

  it('accepts a scale value within explicit min/max range', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 4,
      }),
    ).not.toThrow();
  });

  it('throws when scale value is out of range', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 99,
      }),
    ).toThrow(DiagnosticEntryDataInvalidError);
  });

  it('uses default scale range 1..10 when min/max are omitted', () => {
    const schema: TemplateSchema = {
      sections: [
        {
          title: 'S',
          fields: [
            { key: 'rating', label: 'Rating', type: 'scale', required: true },
          ],
        },
      ],
    };
    expect(() => validateEntryData(schema, { rating: 10 })).not.toThrow();
    expect(() => validateEntryData(schema, { rating: 11 })).toThrow(
      DiagnosticEntryDataInvalidError,
    );
    expect(() => validateEntryData(schema, { rating: 0 })).toThrow(
      DiagnosticEntryDataInvalidError,
    );
  });

  it('silently ignores extra unknown fields not present in template', () => {
    expect(() =>
      validateEntryData(allTypesSchema, {
        age_months: 24,
        is_verbal: true,
        mood: 'happy',
        engagement: 3,
        forwards_compat_key: 'whatever',
      }),
    ).not.toThrow();
  });

  it('attaches details with path=field key on validation failure', () => {
    try {
      validateEntryData(minimalSchema, {});
      fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DiagnosticEntryDataInvalidError);
      const err = e as DiagnosticEntryDataInvalidError;
      expect(err.details.path).toBe('articulation');
      expect(err.details.expected).toBe('required');
      expect(err.details.actual).toBe('missing');
    }
  });
});

describe('deepEqualJson helper', () => {
  it('returns true for structurally identical objects', () => {
    expect(deepEqualJson({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(true);
  });

  it('returns false when values differ', () => {
    expect(deepEqualJson({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns false when array order differs', () => {
    expect(deepEqualJson([1, 2], [2, 1])).toBe(false);
  });
});
