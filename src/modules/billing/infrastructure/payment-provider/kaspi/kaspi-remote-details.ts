/**
 * Pure parser for the Kaspi `qrpay` `remote/details?operationId=<QrOperationId>`
 * response (B24 / K8). Centralises ALL interpretation of the Kaspi status
 * envelope in ONE place so the poller orchestration stays protocol-agnostic.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TODO(kaspi-protocol): verify field paths against live remote/details on the
 * pilot kindergarten.
 *
 * The original `kaspi_pay_test` reference is no longer on disk, so the exact
 * `remote/details` JSON shape is UNVERIFIED. The field paths assumed below are
 * the canonical Kaspi qrpay envelope shape (`{ StatusCode, Data: { Status,
 * ExpireDate, ... } }`, mirroring `remote/create` which returns
 * `Data.QrOperationId`). When the pilot kindergarten goes live, capture a real
 * `remote/details` body and confirm:
 *   - `body.Data.Status` is the QR-operation status string.
 *   - `body.Data.ExpireDate` is the ISO/epoch expiry of the QR operation.
 *   - the non-zero `StatusCode` / error-code session-expired heuristic below.
 * Adjust the constant sets here ONLY — no other K8 file interprets the body.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Tolerance contract (deliberately permissive — an unknown/missing status with
 * no error is `pending` so the poller keeps polling until ExpireDate / hard-cap
 * rather than prematurely failing a real payment):
 *   - httpStatus 401/403                 → session_expired
 *   - 2xx error envelope whose code/message matches the session/token/auth
 *     regex (and a non-zero StatusCode) → session_expired (checked BEFORE the
 *     explicit status map: a 2xx auth-error envelope may carry
 *     `Data.Status: 'Error'`, which the terminal map would otherwise FAIL — we
 *     must refresh the cashier session instead of failing a live payment)
 *   - Data.Status === Processed          → processed
 *   - Data.Status ∈ {RemotePaymentCreated, Wait, Created, New}
 *                                        → pending
 *   - Data.Status ∈ {Canceled, Cancelled, Rejected, Expired, Error, Declined}
 *                                        → terminal
 *   - anything else                      → pending
 */

export type ParsedRemoteDetailsKind =
  | 'processed'
  | 'pending'
  | 'terminal'
  | 'session_expired';

export interface ParsedRemoteDetails {
  kind: ParsedRemoteDetailsKind;
  /** Raw Kaspi status string, for logging only (NEVER a secret). */
  rawStatus: string | null;
  /** Parsed `ExpireDate`; null when absent / unparseable. */
  expireDate: Date | null;
}

// Case-insensitive status maps. Keys are lower-cased Kaspi status strings.
const PROCESSED_STATUSES = new Set<string>(['processed']);

const PENDING_STATUSES = new Set<string>([
  'remotepaymentcreated',
  'wait',
  'created',
  'new',
]);

const TERMINAL_STATUSES = new Set<string>([
  'canceled',
  'cancelled',
  'rejected',
  'expired',
  'error',
  'declined',
]);

/**
 * Known Kaspi error-code substrings that mean "the cashier session/token must
 * be re-authenticated". Matched case-insensitively against the response's
 * error code AND message. Kept small + documented; extend here when a live
 * remote/details surfaces a new session-expiry code.
 */
const SESSION_EXPIRED_PATTERN =
  /session|token|unauthor|expired.?token|re-?auth/i;

export function parseRemoteDetails(
  httpStatus: number,
  json: unknown,
): ParsedRemoteDetails {
  // 1. Transport-level auth rejection — Kaspi rotates the cashier session out.
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'session_expired', rawStatus: null, expireDate: null };
  }

  const body = asRecord(json);
  const data = asRecord(body?.['Data']);

  const rawStatus = asString(data?.['Status']);
  const expireDate = parseExpireDate(data?.['ExpireDate']);

  // 2. Session-expired heuristic on a 2xx error envelope: a non-zero
  //    StatusCode together with a code/message matching the auth regex. This
  //    MUST precede the explicit status map — a 2xx auth-error envelope can
  //    carry `Data.Status: 'Error'`, which is in TERMINAL_STATUSES and would
  //    otherwise FAIL a live payment instead of refreshing the cashier session.
  if (isSessionExpiredEnvelope(body, data)) {
    return { kind: 'session_expired', rawStatus, expireDate };
  }

  // 3. Explicit status mapping (case-insensitive).
  if (rawStatus != null) {
    const lower = rawStatus.toLowerCase();
    if (PROCESSED_STATUSES.has(lower)) {
      return { kind: 'processed', rawStatus, expireDate };
    }
    if (TERMINAL_STATUSES.has(lower)) {
      return { kind: 'terminal', rawStatus, expireDate };
    }
    if (PENDING_STATUSES.has(lower)) {
      return { kind: 'pending', rawStatus, expireDate };
    }
  }

  // 4. Unknown / missing status with no error → pending (safe: keep polling).
  return { kind: 'pending', rawStatus, expireDate };
}

// ── helpers ────────────────────────────────────────────────────────────────

function isSessionExpiredEnvelope(
  body: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
): boolean {
  if (!body) return false;
  const statusCode = body['StatusCode'];
  if (typeof statusCode !== 'number' || statusCode === 0) {
    return false;
  }
  // Collect candidate error code/message strings from the common envelope
  // locations and test each against the session/token/auth regex.
  const candidates: Array<unknown> = [
    body['ErrorCode'],
    body['Error'],
    body['ErrorMessage'],
    body['Message'],
    body['StatusMessage'],
    data?.['ErrorCode'],
    data?.['Error'],
    data?.['ErrorMessage'],
    data?.['Message'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && SESSION_EXPIRED_PATTERN.test(c)) {
      return true;
    }
  }
  return false;
}

function parseExpireDate(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    // Epoch — accept seconds or milliseconds. Values below ~1e12 are seconds.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    // Numeric-looking string → epoch; otherwise ISO.
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object'
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
