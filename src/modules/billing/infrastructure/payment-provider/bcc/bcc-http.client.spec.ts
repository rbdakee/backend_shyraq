import { Logger } from '@nestjs/common';
import {
  BccFetch,
  BccHttpClient,
  parseBccResponseFields,
} from './bcc-http.client';
import { BCC_LIVE_GATEWAY_URL, BCC_TEST_GATEWAY_URL } from './bcc-protocol';

function response(
  body: string,
  status = 200,
  contentType = 'application/x-www-form-urlencoded',
): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('BccHttpClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs UTF-8 form-urlencoded fields to the test gateway', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl: BccFetch = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(
        response(
          'ACTION=0&RC=00&RC_TEXT=APPROVED&ORDER=3558714461568&RRN=123&INT_REF=abc',
        ),
      );
    };
    const client = new BccHttpClient(fetchImpl, {
      timeoutMs: 1_000,
      idempotentRetries: 0,
      retryDelayMs: 0,
    });

    const result = await client.execute('test', {
      TRTYPE: '800',
      TERMINAL: '88888881',
      DESC: 'Оплата счёта',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(BCC_TEST_GATEWAY_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual(
      expect.objectContaining({
        'content-type': 'application/x-www-form-urlencoded',
      }),
    );
    const posted = new URLSearchParams(String(calls[0].init.body));
    expect(posted.get('TERMINAL')).toBe('88888881');
    expect(posted.get('DESC')).toBe('Оплата счёта');
    expect(result.diagnostics).toEqual({
      action: '0',
      rc: '00',
      rcText: 'APPROVED',
      order: '3558714461568',
      rrn: '123',
      intRef: 'abc',
    });
  });

  it('uses the live gateway for live merchant accounts', async () => {
    let calledUrl = '';
    const client = new BccHttpClient(
      (input) => {
        calledUrl = input;
        return Promise.resolve(response('RC=00'));
      },
      { timeoutMs: 1_000, idempotentRetries: 0, retryDelayMs: 0 },
    );

    await client.execute('live', { TRTYPE: '90' });
    expect(calledUrl).toBe(BCC_LIVE_GATEWAY_URL);
  });

  it('normalizes JSON response keys and scalar values', async () => {
    const client = new BccHttpClient(
      () =>
        Promise.resolve(
          response(
            JSON.stringify({ action: 0, rc: '00', rc_text: 'OK' }),
            200,
            'application/json',
          ),
        ),
      { timeoutMs: 1_000, idempotentRetries: 0, retryDelayMs: 0 },
    );

    const result = await client.execute('test', { TRTYPE: '90' });
    expect(result.fields).toEqual({
      ACTION: '0',
      RC: '00',
      RC_TEXT: 'OK',
    });
  });

  it('retries a transport failure for idempotent TRTYPE=90', async () => {
    const fetchImpl = jest
      .fn<ReturnType<BccFetch>, Parameters<BccFetch>>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(response('ACTION=0&RC=00'));
    const client = new BccHttpClient(fetchImpl, {
      timeoutMs: 1_000,
      idempotentRetries: 1,
      retryDelayMs: 0,
    });

    await expect(client.execute('test', { TRTYPE: '90' })).resolves.toEqual(
      expect.objectContaining({ httpStatus: 200 }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries HTTP 5xx for idempotent TRTYPE=800', async () => {
    const fetchImpl = jest
      .fn<ReturnType<BccFetch>, Parameters<BccFetch>>()
      .mockResolvedValueOnce(response('RC=96', 503))
      .mockResolvedValueOnce(response('ACTION=0&RC=00'));
    const client = new BccHttpClient(fetchImpl, {
      timeoutMs: 1_000,
      idempotentRetries: 1,
      retryDelayMs: 0,
    });

    const result = await client.execute('test', { TRTYPE: '800' });
    expect(result.httpStatus).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry TRTYPE=14 after an ambiguous transport failure', async () => {
    const fetchImpl = jest
      .fn<ReturnType<BccFetch>, Parameters<BccFetch>>()
      .mockRejectedValue(new Error('socket closed'));
    const client = new BccHttpClient(fetchImpl, {
      timeoutMs: 1_000,
      idempotentRetries: 3,
      retryDelayMs: 0,
    });

    await expect(client.execute('test', { TRTYPE: '14' })).rejects.toThrow(
      'bcc_http_failed:TRTYPE=14',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts a request at the configured timeout', async () => {
    const fetchImpl: BccFetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const client = new BccHttpClient(fetchImpl, {
      timeoutMs: 5,
      idempotentRetries: 0,
      retryDelayMs: 0,
    });

    await expect(client.execute('test', { TRTYPE: '800' })).rejects.toThrow(
      'bcc_http_failed:TRTYPE=800',
    );
  });

  it('rejects browser-only TRTYPE=1 without making a network request', async () => {
    const fetchImpl = jest.fn<ReturnType<BccFetch>, Parameters<BccFetch>>();
    const client = new BccHttpClient(fetchImpl);

    await expect(
      client.execute('test', { TRTYPE: '1', P_SIGN: 'SECRET' }),
    ).rejects.toThrow('bcc_http_browser_operation_forbidden:1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs only sanitized diagnostics, never request or response secrets', async () => {
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((message) => logged.push(String(message)));
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message) => logged.push(String(message)));
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message) => logged.push(String(message)));
    const client = new BccHttpClient(
      () =>
        Promise.resolve(
          response('ACTION=0&RC=00&RC_TEXT=OK&P_SIGN=RESPONSE_SECRET'),
        ),
      { timeoutMs: 1_000, idempotentRetries: 0, retryDelayMs: 0 },
    );

    await client.execute('test', {
      TRTYPE: '90',
      P_SIGN: 'REQUEST_SECRET',
      CARD: '4111111111111111',
    });

    const output = logged.join('\n');
    expect(output).toContain('ACTION=0');
    expect(output).toContain('RC=00');
    expect(output).not.toContain('REQUEST_SECRET');
    expect(output).not.toContain('RESPONSE_SECRET');
    expect(output).not.toContain('4111111111111111');
  });

  it('does not copy arbitrary transport error messages into logs', async () => {
    const logged: string[] = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message) => logged.push(String(message)));
    const client = new BccHttpClient(
      () =>
        Promise.reject(new Error('request failed with P_SIGN=LEAKED_SECRET')),
      { timeoutMs: 1_000, idempotentRetries: 0, retryDelayMs: 0 },
    );

    await expect(
      client.execute('test', { TRTYPE: '14', P_SIGN: 'LEAKED_SECRET' }),
    ).rejects.toThrow('bcc_http_failed:TRTYPE=14');
    expect(logged.join('\n')).toContain('transport_error');
    expect(logged.join('\n')).not.toContain('LEAKED_SECRET');
  });

  it('does not attempt to parse hosted HTML as gateway fields', () => {
    expect(
      parseBccResponseFields('<html><form action="/3ds"></form></html>'),
    ).toEqual({});
  });
});
