import { WhatsAppConfig } from '../../config/auth-config.type';
import {
  WhatsAppCloudFetch,
  WhatsAppCloudSmsAdapter,
} from './whatsapp-cloud-sms.adapter';

const config: WhatsAppConfig = {
  phoneNumberId: '1083748471495873',
  accessToken: 'test-token',
  apiVersion: 'v21.0',
  businessAccountId: '1505344244376148',
  devRecipientOverride: null,
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Response[]): {
  fetchImpl: WhatsAppCloudFetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl: WhatsAppCloudFetch = (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than expected');
    return Promise.resolve(next);
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WhatsAppCloudSmsAdapter', () => {
  it('posts a freeform text message to the Cloud API and returns the message id', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: '77772270088', wa_id: '77772270088' }],
        messages: [{ id: 'wamid.HBgL.test', message_status: 'accepted' }],
      }),
    ]);
    const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

    const result = await adapter.send('+7 (777) 227-00-88', 'Shyraq: 123456');

    expect(result.txnId).toBe('wamid.HBgL.test');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://graph.facebook.com/v21.0/1083748471495873/messages',
    );
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '77772270088',
      type: 'text',
      text: { preview_url: false, body: 'Shyraq: 123456' },
    });
  });

  it('throws when Meta returns a 4xx with an error payload', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse(400, {
        error: {
          message: 'Re-engagement message',
          type: 'OAuthException',
          code: 131047,
          fbtrace_id: 'AbCdEf',
        },
      }),
    ]);
    const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

    await expect(adapter.send('77772270088', 'Shyraq: 111111')).rejects.toThrow(
      /whatsapp_send_failed: 131047/,
    );
  });

  it('throws when the response is 2xx but contains no message id', async () => {
    const { fetchImpl } = makeFetch([jsonResponse(200, { messages: [] })]);
    const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

    await expect(adapter.send('77772270088', 'x')).rejects.toThrow(
      /missing message id/,
    );
  });

  it('throws when fetch itself rejects (network failure)', async () => {
    const adapter = new WhatsAppCloudSmsAdapter(config, () =>
      Promise.reject(new Error('ECONNRESET')),
    );

    await expect(adapter.send('77772270088', 'x')).rejects.toThrow(
      /whatsapp_send_failed: ECONNRESET/,
    );
  });

  it('reroutes the recipient when devRecipientOverride is set', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(200, { messages: [{ id: 'wamid.override' }] }),
    ]);
    const adapter = new WhatsAppCloudSmsAdapter(
      { ...config, devRecipientOverride: '787772270088' },
      fetchImpl,
    );

    const result = await adapter.send('+77051112233', 'Shyraq: 999000');

    expect(result.txnId).toBe('wamid.override');
    expect(JSON.parse(calls[0].init.body as string).to).toBe('787772270088');
  });
});
