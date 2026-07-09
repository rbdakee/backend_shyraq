import * as crypto from 'crypto';
import Decimal from 'decimal.js';

export type BccSignedTrType = '1' | '14' | '90';

export type BccMacFieldName =
  | 'AMOUNT'
  | 'CURRENCY'
  | 'ORDER'
  | 'MERCHANT'
  | 'TERMINAL'
  | 'MERCH_GMT'
  | 'TIMESTAMP'
  | 'TRTYPE'
  | 'NONCE'
  | 'ORG_AMOUNT'
  | 'RRN'
  | 'INT_REF';

export type BccMacFields = Partial<Record<BccMacFieldName, string>>;

const MAC_FIELD_ORDER: Record<BccSignedTrType, readonly BccMacFieldName[]> = {
  '1': [
    'AMOUNT',
    'CURRENCY',
    'ORDER',
    'MERCHANT',
    'TERMINAL',
    'MERCH_GMT',
    'TIMESTAMP',
    'TRTYPE',
    'NONCE',
  ],
  '14': [
    'ORDER',
    'ORG_AMOUNT',
    'AMOUNT',
    'CURRENCY',
    'RRN',
    'INT_REF',
    'TERMINAL',
    'TIMESTAMP',
    'TRTYPE',
    'NONCE',
  ],
  '90': ['ORDER', 'TERMINAL', 'TIMESTAMP', 'TRTYPE', 'NONCE'],
};

const ASCII_PATTERN = /^[\x20-\x7E]+$/;
const HEX_PATTERN = /^[0-9A-Fa-f]+$/;

function assertSignedTrType(trType: string): asserts trType is BccSignedTrType {
  if (!(trType in MAC_FIELD_ORDER)) {
    throw new Error(`bcc_mac_trtype_unsupported:${trType}`);
  }
}

function requiredAsciiField(
  fields: BccMacFields,
  fieldName: BccMacFieldName,
): string {
  const value = fields[fieldName];
  if (!value) {
    throw new Error(`bcc_mac_field_required:${fieldName}`);
  }
  // BCC's published vectors define length as characters. Protocol identifiers
  // and amounts are ASCII, so rejecting Unicode avoids silently choosing
  // UTF-16 code units versus UTF-8 byte length.
  if (!ASCII_PATTERN.test(value)) {
    throw new Error(`bcc_mac_field_non_ascii:${fieldName}`);
  }
  return value;
}

/**
 * Builds BCC's length-prefixed MAC source in the exact per-TRTYPE field order.
 * Example: AMOUNT='350.00' contributes '6350.00'.
 */
export function buildBccMacSource(
  trType: string,
  fields: BccMacFields,
): string {
  assertSignedTrType(trType);
  if (fields.TRTYPE !== trType) {
    throw new Error('bcc_mac_trtype_mismatch');
  }

  return MAC_FIELD_ORDER[trType]
    .map((fieldName) => {
      const value = requiredAsciiField(fields, fieldName);
      return `${value.length}${value}`;
    })
    .join('');
}

/**
 * HMAC-SHA1 over the BCC source using the HEX-decoded merchant MAC key.
 * BCC requires uppercase HEX output.
 */
export function computeBccPSign(
  trType: string,
  fields: BccMacFields,
  macKeyHex: string,
): string {
  if (macKeyHex.length !== 32 || !HEX_PATTERN.test(macKeyHex)) {
    throw new Error('bcc_mac_key_invalid');
  }

  const source = buildBccMacSource(trType, fields);
  return crypto
    .createHmac('sha1', Buffer.from(macKeyHex, 'hex'))
    .update(source, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** Combines the two 16-byte BCC key components without persisting either one. */
export function combineBccMacKeyComponents(
  component1Hex: string,
  component2Hex: string,
): Buffer {
  if (
    component1Hex.length !== 32 ||
    component2Hex.length !== 32 ||
    !HEX_PATTERN.test(component1Hex) ||
    !HEX_PATTERN.test(component2Hex)
  ) {
    throw new Error('bcc_mac_components_invalid');
  }
  const component1 = Buffer.from(component1Hex, 'hex');
  const component2 = Buffer.from(component2Hex, 'hex');
  const combined = Buffer.alloc(16);
  for (let i = 0; i < combined.length; i += 1) {
    combined[i] = component1[i] ^ component2[i];
  }
  return combined;
}

export function formatBccTimestamp(date: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error('bcc_timestamp_invalid');
  }
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function formatBccAmount(value: Decimal.Value): string {
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new Error('bcc_amount_invalid');
  }
  if (!amount.isFinite() || amount.isNegative()) {
    throw new Error('bcc_amount_invalid');
  }
  return amount.toFixed(2);
}

/** Generates 16-64 uppercase HEX characters; default is 32. */
export function generateBccNonce(byteLength = 16): string {
  if (!Number.isInteger(byteLength) || byteLength < 8 || byteLength > 32) {
    throw new Error('bcc_nonce_length_invalid');
  }
  return crypto.randomBytes(byteLength).toString('hex').toUpperCase();
}

/** Generates a numeric 32-character ORDER: epoch milliseconds + random suffix. */
export function generateBccOrder(now: Date = new Date()): string {
  const epochMs = now.getTime();
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new Error('bcc_order_time_invalid');
  }
  const randomDecimal = BigInt(`0x${crypto.randomBytes(8).toString('hex')}`)
    .toString(10)
    .padStart(19, '0')
    .slice(-19);
  return `${epochMs.toString().padStart(13, '0')}${randomDecimal}`;
}

/** Current BCC contract requires a 16-character alphanumeric MERCH_RN_ID. */
export function generateBccMerchRnId(): string {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

export interface BccConnectivityCheckInput {
  terminal: string;
  backref: string;
  lang: 'ru' | 'kk' | 'en';
  notifyUrl: string;
}

/**
 * Published TRTYPE=800 request has no P_SIGN.
 */
export function buildBccConnectivityCheckRequest(
  input: BccConnectivityCheckInput,
): Record<string, string> {
  if (
    !input.terminal ||
    !input.backref ||
    !input.notifyUrl ||
    !ASCII_PATTERN.test(input.terminal)
  ) {
    throw new Error('bcc_connectivity_check_field_required');
  }
  return {
    TERMINAL: input.terminal,
    TRTYPE: '800',
    BACKREF: input.backref,
    LANG: input.lang,
    NOTIFY_URL: input.notifyUrl,
  };
}
