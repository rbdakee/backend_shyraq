import { DiagnosticTemplateSchemaInvalidError } from './errors/diagnostic-template-schema-invalid.error';
import { DiagnosticEntryDataInvalidError } from './errors/diagnostic-entry-data-invalid.error';
import { SchemaTooLargeError } from './errors/schema-too-large.error';

/**
 * Hard caps on template-schema dimensions (B22a-T6 / H10 — DoS hardening).
 * Exceeding any of these throws `SchemaTooLargeError` (HTTP 422). Exported
 * so unit tests and the admin UI can pin to the same numbers.
 *
 * Rationale: the schema is stored as JSONB and walked by `validateEntryData`
 * on every entry create/patch — uncapped a malicious admin could push a
 * multi-MB schema with O(N*M) entry-validation cost per request.
 */
export const MAX_SECTIONS = 20;
export const MAX_FIELDS_PER_SECTION = 50;
export const MAX_OPTIONS_PER_FIELD = 100;
export const MAX_STRING_LENGTH = 200;

/**
 * Pure validators for diagnostic templates and entries. No NestJS, no I/O,
 * no DI — used by both domain entities (constructor invariants) and
 * service layer (T3) when validating user-supplied payloads.
 */

export type TemplateFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'scale';

export interface TemplateField {
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
  // Forward-compat: extra unknown keys are silently accepted.
  [extra: string]: unknown;
}

export interface TemplateSection {
  title: string;
  fields: TemplateField[];
  [extra: string]: unknown;
}

export interface TemplateSchema {
  sections: TemplateSection[];
  [extra: string]: unknown;
}

const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TYPES: ReadonlySet<string> = new Set([
  'text',
  'number',
  'boolean',
  'select',
  'multiselect',
  'date',
  'scale',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new DiagnosticTemplateSchemaInvalidError({ path, message });
}

function failTooLarge(path: string, limit: string): never {
  throw new SchemaTooLargeError({ path, limit });
}

function assertStringWithinCap(
  path: string,
  raw: string,
  cap: number = MAX_STRING_LENGTH,
): void {
  // B22a T13 M6 (opus) — measure RAW length (untrimmed). Earlier
  // revisions called `raw.trim().length` so an attacker could submit
  // `"a".repeat(200) + " ".repeat(10000)`: trim brought the measure
  // back to 200 (cap-passing) but the raw string still persisted at
  // ~10kB. We still store the raw string; the cap now matches the
  // bytes-written reality.
  if (raw.length > cap) {
    failTooLarge(path, `string length > ${cap}`);
  }
}

/**
 * Validates that an arbitrary value matches the TemplateSchema shape.
 * Throws `DiagnosticTemplateSchemaInvalidError` on first violation with
 * `details: { path, message }`. Path uses JSONPath-ish syntax
 * (`sections[0].fields[2].options`).
 *
 * Forward-compat: unknown extra keys on sections/fields/schema are ignored.
 */
export function validateTemplateSchemaShape(
  schema: unknown,
): asserts schema is TemplateSchema {
  if (!isPlainObject(schema)) {
    fail('', 'schema must be an object');
  }
  const sections = (schema as Record<string, unknown>).sections;
  if (!Array.isArray(sections)) {
    fail('sections', 'sections must be an array');
  }
  if (sections.length < 1) {
    fail('sections', 'sections must contain at least one section');
  }
  if (sections.length > MAX_SECTIONS) {
    failTooLarge('sections', `sections.length > ${MAX_SECTIONS}`);
  }

  const seenKeys = new Set<string>();

  sections.forEach((section, sectionIdx) => {
    const sectionPath = `sections[${sectionIdx}]`;
    if (!isPlainObject(section)) {
      fail(sectionPath, 'section must be an object');
    }
    const title = section.title;
    if (typeof title !== 'string' || title.trim() === '') {
      fail(`${sectionPath}.title`, 'section title must be a non-empty string');
    }
    assertStringWithinCap(`${sectionPath}.title`, title);
    const fields = section.fields;
    if (!Array.isArray(fields)) {
      fail(`${sectionPath}.fields`, 'fields must be an array');
    }
    if (fields.length < 1) {
      fail(`${sectionPath}.fields`, 'section must contain at least one field');
    }
    if (fields.length > MAX_FIELDS_PER_SECTION) {
      failTooLarge(
        `${sectionPath}.fields`,
        `fields.length > ${MAX_FIELDS_PER_SECTION}`,
      );
    }
    fields.forEach((field, fieldIdx) => {
      const fieldPath = `${sectionPath}.fields[${fieldIdx}]`;
      if (!isPlainObject(field)) {
        fail(fieldPath, 'field must be an object');
      }
      const key = field.key;
      if (typeof key !== 'string' || key === '') {
        fail(`${fieldPath}.key`, 'field key must be a non-empty string');
      }
      if (!FIELD_KEY_RE.test(key)) {
        fail(
          `${fieldPath}.key`,
          'field key must match /^[a-z][a-z0-9_]*$/ (snake_case)',
        );
      }
      assertStringWithinCap(`${fieldPath}.key`, key);
      if (seenKeys.has(key)) {
        fail(`${fieldPath}.key`, `duplicate field key: ${key}`);
      }
      seenKeys.add(key);
      const label = field.label;
      if (typeof label !== 'string' || label.trim() === '') {
        fail(`${fieldPath}.label`, 'field label must be a non-empty string');
      }
      assertStringWithinCap(`${fieldPath}.label`, label);
      const type = field.type;
      if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
        fail(
          `${fieldPath}.type`,
          `field type must be one of text|number|boolean|select|multiselect|date|scale`,
        );
      }
      if (typeof field.required !== 'boolean') {
        fail(`${fieldPath}.required`, 'field required must be boolean');
      }

      if (type === 'select' || type === 'multiselect') {
        const options = field.options;
        if (!Array.isArray(options)) {
          fail(`${fieldPath}.options`, `${type} field requires options array`);
        }
        if (options.length < 2) {
          fail(
            `${fieldPath}.options`,
            `${type} field requires at least 2 options`,
          );
        }
        if (options.length > MAX_OPTIONS_PER_FIELD) {
          failTooLarge(
            `${fieldPath}.options`,
            `options.length > ${MAX_OPTIONS_PER_FIELD}`,
          );
        }
        options.forEach((opt, optIdx) => {
          if (typeof opt !== 'string' || opt === '') {
            fail(
              `${fieldPath}.options[${optIdx}]`,
              'option must be a non-empty string',
            );
          }
          assertStringWithinCap(`${fieldPath}.options[${optIdx}]`, opt);
        });
      }

      if (type === 'number' || type === 'scale') {
        const min = field.min;
        const max = field.max;
        if (min !== undefined && typeof min !== 'number') {
          fail(`${fieldPath}.min`, 'min must be a number');
        }
        if (max !== undefined && typeof max !== 'number') {
          fail(`${fieldPath}.max`, 'max must be a number');
        }
        if (
          typeof min === 'number' &&
          typeof max === 'number' &&
          !(min < max)
        ) {
          fail(`${fieldPath}`, 'min must be strictly less than max');
        }
      }
    });
  });
}

/**
 * Validates entry `data` against the (already-validated) template schema.
 * Throws `DiagnosticEntryDataInvalidError` on first violation. Extra keys
 * on `data` not present in the schema are silently ignored (forward-compat).
 *
 * Required-field semantics:
 *   - text:        present, non-empty trimmed string
 *   - multiselect: present, array length ≥ 1
 *   - others:      present, non-null
 *
 * Type expectations per field.type are documented inline.
 */
export function validateEntryData(
  templateSchema: TemplateSchema,
  entryData: Record<string, unknown>,
): void {
  for (const section of templateSchema.sections) {
    for (const field of section.fields) {
      const key = field.key;
      const present = Object.prototype.hasOwnProperty.call(entryData, key);
      const raw = entryData[key];

      if (!present || raw == null) {
        if (field.required) {
          throw new DiagnosticEntryDataInvalidError({
            path: key,
            expected: 'required',
            actual: 'missing',
          });
        }
        continue;
      }

      switch (field.type) {
        case 'text': {
          if (typeof raw !== 'string') {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'string',
              actual: typeof raw,
            });
          }
          if (field.required && raw.trim() === '') {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'required',
              actual: 'empty',
            });
          }
          break;
        }
        case 'number': {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'number',
              actual: typeof raw,
            });
          }
          if (typeof field.min === 'number' && raw < field.min) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: `>= ${field.min}`,
              actual: String(raw),
            });
          }
          if (typeof field.max === 'number' && raw > field.max) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: `<= ${field.max}`,
              actual: String(raw),
            });
          }
          break;
        }
        case 'boolean': {
          if (typeof raw !== 'boolean') {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'boolean',
              actual: typeof raw,
            });
          }
          break;
        }
        case 'select': {
          if (typeof raw !== 'string') {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'string',
              actual: typeof raw,
            });
          }
          if (!field.options || !field.options.includes(raw)) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: `one of ${JSON.stringify(field.options ?? [])}`,
              actual: raw,
            });
          }
          break;
        }
        case 'multiselect': {
          if (!Array.isArray(raw)) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'array',
              actual: typeof raw,
            });
          }
          if (field.required && raw.length === 0) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'required',
              actual: 'empty_array',
            });
          }
          // H13 — reject duplicate elements (semantically a set, not a list).
          if (new Set(raw).size !== raw.length) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'unique elements',
              actual: 'duplicates',
            });
          }
          for (const el of raw) {
            if (typeof el !== 'string') {
              throw new DiagnosticEntryDataInvalidError({
                path: key,
                expected: 'string element',
                actual: typeof el,
              });
            }
            if (!field.options || !field.options.includes(el)) {
              throw new DiagnosticEntryDataInvalidError({
                path: key,
                expected: `element one of ${JSON.stringify(
                  field.options ?? [],
                )}`,
                actual: el,
              });
            }
          }
          break;
        }
        case 'date': {
          if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'YYYY-MM-DD',
              actual: typeof raw === 'string' ? raw : typeof raw,
            });
          }
          // H11 — regex passes 2026-02-30, 2026-13-05, 2026-04-31 etc.
          // Round-trip via Date to enforce real Gregorian calendar dates.
          // Some inputs (e.g. month 13) yield Invalid Date whose
          // .toISOString() throws RangeError — guard with getTime() first.
          const parsed = new Date(`${raw}T00:00:00Z`);
          const reconstructed = Number.isNaN(parsed.getTime())
            ? null
            : parsed.toISOString().slice(0, 10);
          if (reconstructed !== raw) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'valid calendar date (YYYY-MM-DD)',
              actual: raw,
            });
          }
          break;
        }
        case 'scale': {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'number',
              actual: typeof raw,
            });
          }
          // H13 — scale is integer-valued; `typeof === 'number'` lets 3.5 in.
          if (!Number.isInteger(raw)) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: 'integer',
              actual: String(raw),
            });
          }
          const minScale = typeof field.min === 'number' ? field.min : 1;
          const maxScale = typeof field.max === 'number' ? field.max : 10;
          if (raw < minScale) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: `>= ${minScale}`,
              actual: String(raw),
            });
          }
          if (raw > maxScale) {
            throw new DiagnosticEntryDataInvalidError({
              path: key,
              expected: `<= ${maxScale}`,
              actual: String(raw),
            });
          }
          break;
        }
      }
    }
  }
}

/**
 * Pure deep-equal for plain JSON-like values (objects, arrays, primitives).
 * Used by `DiagnosticTemplate.update()` to decide whether to bump the
 * `version` counter when the schema is patched. Order-sensitive for arrays;
 * order-insensitive for object keys.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqualJson(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}
