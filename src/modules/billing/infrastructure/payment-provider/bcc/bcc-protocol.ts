import Decimal from 'decimal.js';
import {
  buildBccConnectivityCheckRequest,
  computeBccPSign,
  formatBccAmount,
} from './bcc-crypto';

export type BccFormFields = Record<string, string>;
export type BccLanguage = 'ru' | 'kk' | 'en';

export const BCC_TEST_GATEWAY_URL =
  'https://test3ds.bcc.kz:5445/cgi-bin/cgi_link';
export const BCC_LIVE_GATEWAY_URL = 'https://3dsecure.bcc.kz/webview';

const ORDER_PATTERN = /^\d{7,32}$/;
const TIMESTAMP_PATTERN = /^\d{14}$/;
const NONCE_PATTERN = /^[0-9A-Fa-f]{16,64}$/;
const CURRENCY_PATTERN = /^\d{3}$/;
const MERCH_RN_ID_PATTERN = /^[0-9A-Za-z]{16}$/;

export interface BccPurchaseRequestInput {
  amount: Decimal.Value;
  currency?: string;
  order: string;
  merchRnId: string;
  description: string;
  merchantId: string;
  merchantName?: string | null;
  terminalId: string;
  timestamp: string;
  nonce: string;
  macKeyHex: string;
  backref: string;
  language: BccLanguage;
  notifyUrl: string;
  clientIp: string;
  mInfo: string;
}

export interface BccRefundRequestInput {
  order: string;
  originalAmount: Decimal.Value;
  amount: Decimal.Value;
  currency?: string;
  rrn: string;
  intRef: string;
  terminalId: string;
  timestamp: string;
  nonce: string;
  macKeyHex: string;
  notifyUrl?: string;
}

export interface BccStatusRequestInput {
  order: string;
  terminalId: string;
  timestamp: string;
  nonce: string;
  macKeyHex: string;
  notifyUrl: string;
  transactionType?: '1' | '14';
}

export function bccGatewayUrl(environment: 'test' | 'live'): string {
  return environment === 'test' ? BCC_TEST_GATEWAY_URL : BCC_LIVE_GATEWAY_URL;
}

/**
 * Builds the signed purchase form that the Shyraq checkout bridge will POST
 * from the browser/WebView. This function never performs network I/O.
 *
 * MK_TOKEN/RQ_AUTH are intentionally absent: tokenization and NON3DSECURE are
 * outside the first-version scope.
 */
export function buildBccPurchaseRequest(
  input: BccPurchaseRequestInput,
): BccFormFields {
  assertOrder(input.order);
  assertTimestamp(input.timestamp);
  assertNonce(input.nonce);
  assertMerchRnId(input.merchRnId);
  requireNonEmpty('DESC', input.description);
  requireNonEmpty('MERCHANT', input.merchantId);
  requireNonEmpty('TERMINAL', input.terminalId);
  requireNonEmpty('BACKREF', input.backref);
  requireNonEmpty('NOTIFY_URL', input.notifyUrl);
  requireNonEmpty('CLIENT_IP', input.clientIp);
  requireNonEmpty('M_INFO', input.mInfo);

  const amount = formatBccAmount(input.amount);
  const currency = normalizeCurrency(input.currency);
  const signedFields = {
    AMOUNT: amount,
    CURRENCY: currency,
    ORDER: input.order,
    MERCHANT: input.merchantId,
    TERMINAL: input.terminalId,
    MERCH_GMT: '0',
    TIMESTAMP: input.timestamp,
    TRTYPE: '1',
    NONCE: input.nonce,
  } as const;

  const fields: BccFormFields = {
    ...signedFields,
    MERCH_RN_ID: input.merchRnId,
    DESC: input.description,
    BACKREF: input.backref,
    LANG: input.language,
    NOTIFY_URL: input.notifyUrl,
    CLIENT_IP: input.clientIp,
    M_INFO: input.mInfo,
    P_SIGN: computeBccPSign('1', signedFields, input.macKeyHex),
  };
  if (input.merchantName) fields.MERCH_NAME = input.merchantName;
  return fields;
}

export function buildBccRefundRequest(
  input: BccRefundRequestInput,
): BccFormFields {
  assertOrder(input.order);
  assertTimestamp(input.timestamp);
  assertNonce(input.nonce);
  requireNonEmpty('RRN', input.rrn);
  requireNonEmpty('INT_REF', input.intRef);
  requireNonEmpty('TERMINAL', input.terminalId);

  const originalAmount = formatBccAmount(input.originalAmount);
  const amount = formatBccAmount(input.amount);
  const currency = normalizeCurrency(input.currency);
  const signedFields = {
    ORDER: input.order,
    ORG_AMOUNT: originalAmount,
    AMOUNT: amount,
    CURRENCY: currency,
    RRN: input.rrn,
    INT_REF: input.intRef,
    TERMINAL: input.terminalId,
    TIMESTAMP: input.timestamp,
    TRTYPE: '14',
    NONCE: input.nonce,
  } as const;

  const fields: BccFormFields = {
    ...signedFields,
    P_SIGN: computeBccPSign('14', signedFields, input.macKeyHex),
  };
  if (input.notifyUrl) fields.NOTIFY_URL = input.notifyUrl;
  return fields;
}

export function buildBccStatusRequest(
  input: BccStatusRequestInput,
): BccFormFields {
  assertOrder(input.order);
  assertTimestamp(input.timestamp);
  assertNonce(input.nonce);
  requireNonEmpty('TERMINAL', input.terminalId);
  requireNonEmpty('NOTIFY_URL', input.notifyUrl);

  const signedFields = {
    ORDER: input.order,
    TERMINAL: input.terminalId,
    TIMESTAMP: input.timestamp,
    TRTYPE: '90',
    NONCE: input.nonce,
  } as const;

  return {
    ...signedFields,
    TRAN_TRTYPE: input.transactionType ?? '1',
    MERCH_GMT: '0',
    NOTIFY_URL: input.notifyUrl,
    P_SIGN: computeBccPSign('90', signedFields, input.macKeyHex),
  };
}

export { buildBccConnectivityCheckRequest };

function normalizeCurrency(currency = '398'): string {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new Error('bcc_request_currency_invalid');
  }
  return currency;
}

function assertOrder(order: string): void {
  if (!ORDER_PATTERN.test(order)) {
    throw new Error('bcc_request_order_invalid');
  }
}

function assertTimestamp(timestamp: string): void {
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    throw new Error('bcc_request_timestamp_invalid');
  }
}

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('bcc_request_nonce_invalid');
  }
}

function assertMerchRnId(merchRnId: string): void {
  if (!MERCH_RN_ID_PATTERN.test(merchRnId)) {
    throw new Error('bcc_request_merch_rn_id_invalid');
  }
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim() === '') {
    throw new Error(`bcc_request_field_required:${field}`);
  }
}
