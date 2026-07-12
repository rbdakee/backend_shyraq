import { timingSafeEqual } from 'node:crypto';
import Decimal from 'decimal.js';

const REQUIRED_FIELDS = [
  'ACTION',
  'RC',
  'ORDER',
  'AMOUNT',
  'CURRENCY',
  'TERMINAL',
  'MERCHANT',
] as const;

export interface BccCallbackFields {
  action: string;
  rc: string;
  rcText: string | null;
  order: string;
  amountKzt: number;
  amount: string;
  currency: string;
  terminal: string;
  merchant: string;
  rrn: string | null;
  intRef: string | null;
}

export function parseBccBasicAuthorization(
  value: string | string[] | undefined,
): { username: string; password: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(value.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (Buffer.from(decoded, 'utf8').toString('base64') !== match[1]) return null;
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (
    !username ||
    !password ||
    username.length > 128 ||
    password.length > 256
  ) {
    return null;
  }
  return { username, password };
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function parseBccCallbackBody(body: unknown): BccCallbackFields {
  if (!isRecord(body) || Object.keys(body).length > 128) {
    throw new Error('bcc_callback_body_invalid');
  }
  const fields: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(body)) {
    if (
      !/^[A-Za-z0-9_]{1,64}$/.test(rawKey) ||
      typeof rawValue !== 'string' ||
      rawValue.length > 1024
    ) {
      throw new Error('bcc_callback_body_invalid');
    }
    fields[rawKey.toUpperCase()] = rawValue;
  }
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field]) throw new Error(`bcc_callback_field_required:${field}`);
  }
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(fields.ACTION)) {
    throw new Error('bcc_callback_action_invalid');
  }
  if (!/^-?[0-9A-Za-z]{1,8}$/.test(fields.RC)) {
    throw new Error('bcc_callback_rc_invalid');
  }
  if (!/^\d{7,32}$/.test(fields.ORDER)) {
    throw new Error('bcc_callback_order_invalid');
  }
  if (!/^\d{3}$/.test(fields.CURRENCY)) {
    throw new Error('bcc_callback_currency_invalid');
  }
  if (fields.TERMINAL.length > 64 || fields.MERCHANT.length > 128) {
    throw new Error('bcc_callback_identity_invalid');
  }

  let amount: Decimal;
  try {
    amount = new Decimal(fields.AMOUNT);
  } catch {
    throw new Error('bcc_callback_amount_invalid');
  }
  if (
    !/^\d{1,10}\.\d{2}$/.test(fields.AMOUNT) ||
    !amount.isPositive() ||
    amount.decimalPlaces() > 2
  ) {
    throw new Error('bcc_callback_amount_invalid');
  }

  return {
    action: fields.ACTION,
    rc: fields.RC,
    rcText: sanitizeText(fields.RC_TEXT ?? fields.DIAG),
    order: fields.ORDER,
    amountKzt: amount.toNumber(),
    amount: amount.toFixed(2),
    currency: fields.CURRENCY,
    terminal: fields.TERMINAL,
    merchant: fields.MERCHANT,
    rrn: sanitizeIdentifier(fields.RRN, 32),
    intRef: sanitizeIdentifier(fields.INT_REF, 128),
  };
}

export function isBccSuccess(
  action: string | null,
  rc: string | null,
): boolean {
  return action === '0' && rc === '00';
}

export function isBccTerminalFailure(
  action: string | null,
  rc: string | null,
): boolean {
  return (
    action === '1' ||
    action === '2' ||
    action === '3' ||
    (rc !== null && rc !== '' && rc !== '00' && action === '0')
  );
}

function sanitizeText(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
}

function sanitizeIdentifier(
  value: string | undefined,
  maxLength: number,
): string | null {
  if (!value) return null;
  return /^[0-9A-Za-z_-]+$/.test(value) ? value.slice(0, maxLength) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
