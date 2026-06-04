import { Injectable, Logger } from '@nestjs/common';

export type KaspiFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface KaspiHttpResponse {
  /** HTTP status code as returned by Kaspi. */
  status: number;
  /** Parsed JSON body, or null if the body was empty/non-JSON. */
  json: unknown;
}

export interface KaspiRequestOptions {
  /** Fully assembled request headers (signed — see `signedQrPayHeaders`). */
  headers: Record<string, string>;
  /** Optional JSON request body. */
  body?: unknown;
}

/**
 * Thin, dumb HTTP wrapper for Kaspi `qrpay` calls. It knows NOTHING about
 * signing — callers pass already-signed headers (from `signedQrPayHeaders`).
 *
 * Behaviour (mirrors `WhatsAppCloudSmsAdapter`):
 *   - Uses bare `globalThis.fetch` by default; `fetchImpl` is injectable for tests.
 *   - Throws `Error('kaspi_http_failed: ...')` ONLY on network/transport failure.
 *   - Does NOT throw on non-2xx — returns `{ status, json }` so the K6 adapter can
 *     interpret Kaspi's error envelope (which carries meaningful codes on 4xx).
 *   - Parses JSON safely; a non-JSON body yields `json: null`.
 */
@Injectable()
export class KaspiHttpClient {
  private readonly logger = new Logger(KaspiHttpClient.name);
  private readonly fetchImpl: KaspiFetch;

  constructor(fetchImpl?: KaspiFetch) {
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => globalThis.fetch(input as RequestInfo, init));
  }

  async request(
    method: 'GET' | 'POST',
    url: string,
    opts: KaspiRequestOptions,
  ): Promise<KaspiHttpResponse> {
    const init: RequestInit = {
      method,
      headers: opts.headers,
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`Kaspi ${method} ${url} failed (network): ${reason}`);
      throw new Error(`kaspi_http_failed: ${reason}`);
    }

    const json = await safeJson(response);

    if (!response.ok) {
      this.logger.warn(
        `Kaspi ${method} ${url} non-2xx: status=${response.status}`,
      );
    }

    return { status: response.status, json };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}
