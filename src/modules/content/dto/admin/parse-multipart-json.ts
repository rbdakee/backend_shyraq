/**
 * In multipart/form-data every field arrives as a string, so object fields
 * (`title_i18n`, `body_i18n`, `metadata`) are sent JSON-stringified (see the
 * controller's ApiBody). Parse them back before `@IsObject()` runs; a value
 * that is not valid JSON is left as-is so validation rejects it with 422.
 */
export function parseMultipartJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
