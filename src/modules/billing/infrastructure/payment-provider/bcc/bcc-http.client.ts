import { Injectable, Logger, Optional } from '@nestjs/common';
import { BccFormFields, bccGatewayUrl } from './bcc-protocol';

export type BccFetch = (input: string, init: RequestInit) => Promise<Response>;

export type BccServerTrType = '14' | '90' | '800';

export interface BccGatewayDiagnostics {
  action: string | null;
  rc: string | null;
  rcText: string | null;
  order: string | null;
  rrn: string | null;
  intRef: string | null;
}

export interface BccGatewayResponse {
  httpStatus: number;
  httpOk: boolean;
  fields: Readonly<Record<string, string>>;
  diagnostics: BccGatewayDiagnostics;
}

export interface BccHttpClientOptions {
  timeoutMs: number;
  /** Number of extra attempts for idempotent TRTYPE=90/800. */
  idempotentRetries: number;
  retryDelayMs: number;
}

const IDEMPOTENT_TR_TYPES = new Set<BccServerTrType>(['90', '800']);

/**
 * Server-to-server BCC transport for TRTYPE=14/90/800.
 *
 * TRTYPE=1 is deliberately rejected because purchase must be submitted by the
 * browser/WebView. Request fields and response bodies are never logged.
 */
@Injectable()
export class BccHttpClient {
  private readonly logger = new Logger(BccHttpClient.name);
  private readonly fetchImpl: BccFetch;
  private readonly options: BccHttpClientOptions;

  constructor(
    @Optional() fetchImpl?: BccFetch,
    @Optional() options?: Partial<BccHttpClientOptions>,
  ) {
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => globalThis.fetch(input as RequestInfo, init));
    this.options = {
      timeoutMs:
        options?.timeoutMs ??
        readNonNegativeInteger('BCC_HTTP_TIMEOUT_MS', 10_000, false),
      idempotentRetries:
        options?.idempotentRetries ??
        readNonNegativeInteger('BCC_HTTP_IDEMPOTENT_RETRIES', 1, true),
      retryDelayMs:
        options?.retryDelayMs ??
        readNonNegativeInteger('BCC_HTTP_RETRY_DELAY_MS', 200, true),
    };
  }

  async execute(
    environment: 'test' | 'live',
    fields: Readonly<BccFormFields>,
  ): Promise<BccGatewayResponse> {
    const trType = assertServerTrType(fields.TRTYPE);
    const maxAttempts = IDEMPOTENT_TR_TYPES.has(trType)
      ? 1 + this.options.idempotentRetries
      : 1;
    const url = bccGatewayUrl(environment);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.performRequest(url, fields);
        const shouldRetry = result.httpStatus >= 500 && attempt < maxAttempts;
        if (shouldRetry) {
          this.logger.warn(
            `BCC TRTYPE=${trType} attempt=${attempt}/${maxAttempts} ` +
              `HTTP ${result.httpStatus}; retrying idempotent operation`,
          );
          await this.waitBeforeRetry();
          continue;
        }

        this.logDiagnostics(trType, result);
        return result;
      } catch (error) {
        const reason = safeErrorReason(error);
        if (attempt < maxAttempts) {
          this.logger.warn(
            `BCC TRTYPE=${trType} attempt=${attempt}/${maxAttempts} ` +
              `transport failure=${reason}; retrying idempotent operation`,
          );
          await this.waitBeforeRetry();
          continue;
        }
        this.logger.error(
          `BCC TRTYPE=${trType} transport failed after ${attempt} ` +
            `attempt(s): ${reason}`,
        );
        throw new Error(`bcc_http_failed:TRTYPE=${trType}`);
      }
    }

    throw new Error(`bcc_http_failed:TRTYPE=${trType}`);
  }

  private async performRequest(
    url: string,
    fields: Readonly<BccFormFields>,
  ): Promise<BccGatewayResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept:
            'application/x-www-form-urlencoded, application/json, text/plain, */*',
        },
        body: new URLSearchParams(fields).toString(),
        signal: controller.signal,
      });
      const body = await response.text();
      const contentType = response.headers?.get('content-type') ?? '';
      const parsedFields = parseBccResponseFields(body, contentType);
      return {
        httpStatus: response.status,
        httpOk: response.ok,
        fields: parsedFields,
        diagnostics: mapBccDiagnostics(parsedFields),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private logDiagnostics(
    trType: BccServerTrType,
    response: BccGatewayResponse,
  ): void {
    const { action, rc, rcText } = response.diagnostics;
    const message =
      `BCC TRTYPE=${trType} HTTP=${response.httpStatus} ` +
      `ACTION=${action ?? '-'} RC=${rc ?? '-'} ` +
      `RC_TEXT=${sanitizeDiagnosticText(rcText)}`;
    if (response.httpOk) this.logger.log(message);
    else this.logger.warn(message);
  }

  private async waitBeforeRetry(): Promise<void> {
    if (this.options.retryDelayMs === 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.options.retryDelayMs);
    });
  }
}

export function parseBccResponseFields(
  body: string,
  contentType = '',
): Readonly<Record<string, string>> {
  const trimmed = body.trim();
  if (trimmed === '') return {};

  if (
    contentType.toLowerCase().includes('application/json') ||
    trimmed.startsWith('{')
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) return normalizeResponseRecord(parsed);
    } catch {
      return {};
    }
  }

  const looksLikeForm =
    contentType.toLowerCase().includes('application/x-www-form-urlencoded') ||
    (!trimmed.startsWith('<') && trimmed.includes('='));
  if (!looksLikeForm) return {};

  const fields: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(trimmed)) {
    fields[key.toUpperCase()] = value;
  }
  return fields;
}

export function mapBccDiagnostics(
  fields: Readonly<Record<string, string>>,
): BccGatewayDiagnostics {
  return {
    action: fields.ACTION ?? null,
    rc: fields.RC ?? null,
    rcText: fields.RC_TEXT ?? fields.DIAG ?? null,
    order: fields.ORDER ?? null,
    rrn: fields.RRN ?? null,
    intRef: fields.INT_REF ?? null,
  };
}

function assertServerTrType(value: string | undefined): BccServerTrType {
  if (value === '1') {
    throw new Error('bcc_http_browser_operation_forbidden:1');
  }
  if (value !== '14' && value !== '90' && value !== '800') {
    throw new Error(`bcc_http_trtype_unsupported:${value ?? 'missing'}`);
  }
  return value;
}

function normalizeResponseRecord(
  value: Record<string, unknown>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    ) {
      normalized[key.toUpperCase()] = String(fieldValue);
    }
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeDiagnosticText(value: string | null): string {
  if (!value) return '-';
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function safeErrorReason(error: unknown): string {
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    (isRecord(error) && error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  if (isRecord(error) && typeof error.code === 'string') {
    return /^[A-Z0-9_]+$/.test(error.code)
      ? error.code.slice(0, 64)
      : 'transport_error';
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) {
    return error.message.slice(0, 64);
  }
  return 'transport_error';
}

function readNonNegativeInteger(
  envName: string,
  fallback: number,
  allowZero: boolean,
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(`bcc_http_config_invalid:${envName}`);
  }
  return value;
}
