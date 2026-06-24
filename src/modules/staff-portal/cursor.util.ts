import { BadRequestException } from '@nestjs/common';

/**
 * Opaque pagination cursor for the Staff-App roster / specialist-children
 * lists. The cursor is the base64url encoding of the next OFFSET into the
 * underlying offset-based `ChildRepository.list`. We keep the on-the-wire shape
 * opaque (clients must treat it as a black box) while internally translating it
 * to/from a plain integer offset.
 *
 *   encodeCursor(40) -> "NDA"  (base64url of "40")
 *   decodeCursor("NDA") -> 40
 *
 * A malformed / non-numeric / negative cursor is rejected with a 400 so a
 * tampered cursor never silently resolves to offset 0.
 */
const INVALID_CURSOR_CODE = 'invalid_cursor';

/** base64url-encode the next offset into an opaque cursor string. */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor back into a non-negative integer offset. Throws a
 * `BadRequestException({ code: 'invalid_cursor' })` (→ HTTP 400) when the value
 * is not a base64url-encoded non-negative integer.
 */
export function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // The decoded payload must be a bare run of digits (no sign, no whitespace,
  // no leading zeros beyond a single "0"). `Buffer.from(..., 'base64url')`
  // silently drops bytes it cannot decode, so this exact-shape check is the
  // real guard against a tampered / malformed cursor.
  if (!/^(0|[1-9]\d*)$/.test(decoded)) {
    throw new BadRequestException({ code: INVALID_CURSOR_CODE });
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new BadRequestException({ code: INVALID_CURSOR_CODE });
  }
  return offset;
}
