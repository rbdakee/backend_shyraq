/**
 * `maskKzPhone` — privacy-preserving rendering of a Kazakh phone number
 * for list endpoints.
 *
 * Closes FINDINGS B11 H4: list responses (e.g. `GET /staff/pickup-requests`)
 * leak full `trusted_person_phone` plaintext for every row. The
 * single-get endpoint (`GET /staff/pickup-requests/:id`) is opt-in and
 * still returns the full number; only list-shaped responses adopt the
 * masked form.
 *
 * Format:
 *   - Canonical KZ E.164 `+7XXXXXXXXXX` (12 chars total) → `+7***LAST4`.
 *   - Anything else (too short, missing leading `+7`, foreign format) →
 *     a best-effort tail-mask: `***LAST4` if at least 4 chars, otherwise
 *     `***`. Empty / whitespace input → `''` so callers that gate on
 *     truthiness still behave the same way.
 *
 * Pure function — no DI, no side effects. Lives in `shared-kernel/utils`
 * so any module's presenter can import it without crossing module
 * boundaries.
 */
export function maskKzPhone(phone: string): string {
  if (typeof phone !== 'string') return '***';
  const trimmed = phone.trim();
  if (trimmed.length === 0) return '';

  // Canonical KZ E.164 — `+7` followed by exactly 10 digits.
  if (/^\+7\d{10}$/.test(trimmed)) {
    return `+7***${trimmed.slice(-4)}`;
  }

  // Best-effort fallback for non-canonical strings. We don't try to be
  // clever about parsing — any digit-bearing string ≥ 4 chars gets its
  // last 4 visible with `***` prefix; shorter strings collapse to `***`.
  if (trimmed.length >= 4) {
    return `***${trimmed.slice(-4)}`;
  }
  return '***';
}
