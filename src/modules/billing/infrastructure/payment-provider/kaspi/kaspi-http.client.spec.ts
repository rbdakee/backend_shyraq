import { KaspiFetch, KaspiHttpClient } from './kaspi-http.client';

/**
 * K5 added `setCookie` to `KaspiHttpResponse`. These tests pin the additive,
 * non-breaking behaviour: existing `{status, json}` fields are unchanged, and
 * `setCookie` surfaces the response's set-cookie values for the entrance flow.
 */
describe('KaspiHttpClient.setCookie', () => {
  function fetchReturning(headers: Headers, body: unknown): KaspiFetch {
    return () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers,
        json: () => Promise.resolve(body),
      } as unknown as Response);
  }

  it('exposes set-cookie values via Headers.getSetCookie()', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'user_token=UT1; Path=/');
    headers.append('set-cookie', 'other=x; Path=/');
    const client = new KaspiHttpClient(fetchReturning(headers, { ok: 1 }));

    const res = await client.request('POST', 'https://x/api', { headers: {} });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: 1 });
    expect(res.setCookie).toEqual([
      'user_token=UT1; Path=/',
      'other=x; Path=/',
    ]);
  });

  it('returns an empty setCookie array when no cookies are set', async () => {
    const client = new KaspiHttpClient(fetchReturning(new Headers(), {}));
    const res = await client.request('GET', 'https://x/api', { headers: {} });
    expect(res.setCookie).toEqual([]);
  });

  it('degrades to a single get("set-cookie") for non-undici Headers stubs', async () => {
    // A minimal Headers-like stub without getSetCookie (e.g. a hand-rolled
    // test double) must not crash — the client feature-detects getSetCookie.
    const stub = {
      get: (name: string) => (name === 'set-cookie' ? 'user_token=UT9' : null),
    } as unknown as Headers;
    const client = new KaspiHttpClient(fetchReturning(stub, {}));
    const res = await client.request('GET', 'https://x/api', { headers: {} });
    expect(res.setCookie).toEqual(['user_token=UT9']);
  });
});
