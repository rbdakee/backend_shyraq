import {
  MAX_FIELDS_PER_SECTION,
  MAX_OPTIONS_PER_FIELD,
  MAX_SECTIONS,
  MAX_STRING_LENGTH,
  TemplateSchema,
  validateTemplateSchemaShape,
  validateEntryData,
  deepEqualJson,
} from './schema-validators';
import { DiagnosticTemplateSchemaInvalidError } from './errors/diagnostic-template-schema-invalid.error';
import { DiagnosticEntryDataInvalidError } from './errors/diagnostic-entry-data-invalid.error';
import { SchemaTooLargeError } from './errors/schema-too-large.error';

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

describe('B22a-T6 hardening — DoS caps + date round-trip + multiselect/scale', () => {
  // --- helpers --------------------------------------------------------

  const makeField = (key: string) => ({
    key,
    label: `Label ${key}`,
    type: 'text' as const,
    required: false,
  });

  const makeSection = (title: string, fieldCount: number, prefix: string) => ({
    title,
    fields: Array.from({ length: fieldCount }, (_, i) =>
      makeField(`${prefix}_${i}`),
    ),
  });

  // --- H10 — DoS caps -------------------------------------------------

  describe('H10 — schema DoS caps (validateTemplateSchemaShape)', () => {
    it('throws SchemaTooLargeError when sections.length === MAX_SECTIONS + 1', () => {
      const schema = {
        sections: Array.from({ length: MAX_SECTIONS + 1 }, (_, i) =>
          makeSection(`Section ${i}`, 1, `s${i}`),
        ),
      };
      expect(() => validateTemplateSchemaShape(schema)).toThrow(
        SchemaTooLargeError,
      );
    });

    it('accepts sections.length === MAX_SECTIONS (boundary)', () => {
      const schema = {
        sections: Array.from({ length: MAX_SECTIONS }, (_, i) =>
          makeSection(`Section ${i}`, 1, `s${i}`),
        ),
      };
      expect(() => validateTemplateSchemaShape(schema)).not.toThrow();
    });

    it('throws SchemaTooLargeError when fields.length === MAX_FIELDS_PER_SECTION + 1', () => {
      const schema = {
        sections: [makeSection('S', MAX_FIELDS_PER_SECTION + 1, 'f')],
      };
      expect(() => validateTemplateSchemaShape(schema)).toThrow(
        SchemaTooLargeError,
      );
    });

    it('accepts fields.length === MAX_FIELDS_PER_SECTION (boundary)', () => {
      const schema = {
        sections: [makeSection('S', MAX_FIELDS_PER_SECTION, 'f')],
      };
      expect(() => validateTemplateSchemaShape(schema)).not.toThrow();
    });

    it('throws SchemaTooLargeError when multi_select options.length === MAX_OPTIONS_PER_FIELD + 1', () => {
      const schema = {
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'tags',
                label: 'Tags',
                type: 'multiselect' as const,
                required: false,
                options: Array.from(
                  { length: MAX_OPTIONS_PER_FIELD + 1 },
                  (_, i) => `opt_${i}`,
                ),
              },
            ],
          },
        ],
      };
      expect(() => validateTemplateSchemaShape(schema)).toThrow(
        SchemaTooLargeError,
      );
    });

    it('accepts options.length === MAX_OPTIONS_PER_FIELD (boundary)', () => {
      const schema = {
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'tags',
                label: 'Tags',
                type: 'multiselect' as const,
                required: false,
                options: Array.from(
                  { length: MAX_OPTIONS_PER_FIELD },
                  (_, i) => `opt_${i}`,
                ),
              },
            ],
          },
        ],
      };
      expect(() => validateTemplateSchemaShape(schema)).not.toThrow();
    });

    it('throws SchemaTooLargeError when a field label trim length === MAX_STRING_LENGTH + 1', () => {
      const overlongLabel = 'x'.repeat(MAX_STRING_LENGTH + 1);
      const schema = {
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'note',
                label: overlongLabel,
                type: 'text' as const,
                required: false,
              },
            ],
          },
        ],
      };
      expect(() => validateTemplateSchemaShape(schema)).toThrow(
        SchemaTooLargeError,
      );
    });

    it('throws SchemaTooLargeError when an option label exceeds MAX_STRING_LENGTH', () => {
      const overlong = 'o'.repeat(MAX_STRING_LENGTH + 1);
      const schema = {
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'mood',
                label: 'Mood',
                type: 'select' as const,
                required: false,
                options: ['ok', overlong],
              },
            ],
          },
        ],
      };
      expect(() => validateTemplateSchemaShape(schema)).toThrow(
        SchemaTooLargeError,
      );
    });

    it('accepts a string of exactly MAX_STRING_LENGTH (boundary)', () => {
      const exact = 'x'.repeat(MAX_STRING_LENGTH);
      const schema = {
        sections: [
          {
            title: exact,
            fields: [makeField('note')],
          },
        ],
      };
      expect(() => validateTemplateSchemaShape(schema)).not.toThrow();
    });

    it('rejects a trim-bypass attempt where raw length exceeds the cap (T13 M6)', () => {
      // Trim length === MAX_STRING_LENGTH (would have passed the old
      // trim-based check), raw length == MAX_STRING_LENGTH + 1000.
      const trimmedCore = 'x'.repeat(MAX_STRING_LENGTH);
      const padded = trimmedCore + ' '.repeat(1000);
      expect(padded.trim().length).toBe(MAX_STRING_LENGTH);
      expect(padded.length).toBe(MAX_STRING_LENGTH + 1000);
      const schema = {
        sections: [
          {
            title: padded,
            fields: [makeField('note')],
          },
        ],
      };
      expect(() => validateTemplateSchemaShape(schema)).toThrow(
        SchemaTooLargeError,
      );
    });

    it('attaches details with path + limit on cap violation', () => {
      const schema = {
        sections: Array.from({ length: MAX_SECTIONS + 1 }, (_, i) =>
          makeSection(`Section ${i}`, 1, `s${i}`),
        ),
      };
      try {
        validateTemplateSchemaShape(schema);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(SchemaTooLargeError);
        const err = e as SchemaTooLargeError;
        expect(err.code).toBe('schema_too_large');
        expect(err.details.path).toBe('sections');
        expect(err.details.limit).toContain(String(MAX_SECTIONS));
      }
    });
  });

  // --- H11 — date round-trip ------------------------------------------

  describe('H11 — date field round-trip (validateEntryData)', () => {
    const dateSchema: TemplateSchema = {
      sections: [
        {
          title: 'S',
          fields: [
            { key: 'observed_at', label: 'Date', type: 'date', required: true },
          ],
        },
      ],
    };

    it('throws on Feb 30 (regex passes, calendar rejects)', () => {
      expect(() =>
        validateEntryData(dateSchema, { observed_at: '2026-02-30' }),
      ).toThrow(DiagnosticEntryDataInvalidError);
    });

    it('throws on month 13', () => {
      expect(() =>
        validateEntryData(dateSchema, { observed_at: '2026-13-05' }),
      ).toThrow(DiagnosticEntryDataInvalidError);
    });

    it('throws on April 31 (30-day month overflow)', () => {
      expect(() =>
        validateEntryData(dateSchema, { observed_at: '2026-04-31' }),
      ).toThrow(DiagnosticEntryDataInvalidError);
    });

    it('throws on Feb 29 in a non-leap year', () => {
      expect(() =>
        validateEntryData(dateSchema, { observed_at: '2025-02-29' }),
      ).toThrow(DiagnosticEntryDataInvalidError);
    });

    it('accepts Feb 29 in a leap year (2024)', () => {
      expect(() =>
        validateEntryData(dateSchema, { observed_at: '2024-02-29' }),
      ).not.toThrow();
    });

    it('accepts a normal valid date 2026-05-13', () => {
      expect(() =>
        validateEntryData(dateSchema, { observed_at: '2026-05-13' }),
      ).not.toThrow();
    });
  });

  // --- H13 — multiselect duplicates + scale integer -------------------

  describe('H13 — multiselect duplicates (validateEntryData)', () => {
    const multiSchema: TemplateSchema = {
      sections: [
        {
          title: 'S',
          fields: [
            {
              key: 'tags',
              label: 'Tags',
              type: 'multiselect',
              required: false,
              options: ['a', 'b', 'c'],
            },
          ],
        },
      ],
    };

    it('throws on duplicate elements in multiselect', () => {
      expect(() =>
        validateEntryData(multiSchema, { tags: ['a', 'b', 'a'] }),
      ).toThrow(DiagnosticEntryDataInvalidError);
    });

    it('accepts unique multiselect elements', () => {
      expect(() =>
        validateEntryData(multiSchema, { tags: ['a', 'b'] }),
      ).not.toThrow();
    });
  });

  describe('H13 — scale must be integer (validateEntryData)', () => {
    const scaleSchema: TemplateSchema = {
      sections: [
        {
          title: 'S',
          fields: [
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

    it('throws on non-integer scale value 3.5', () => {
      expect(() => validateEntryData(scaleSchema, { engagement: 3.5 })).toThrow(
        DiagnosticEntryDataInvalidError,
      );
    });

    it('accepts an integer scale value', () => {
      expect(() =>
        validateEntryData(scaleSchema, { engagement: 4 }),
      ).not.toThrow();
    });
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
