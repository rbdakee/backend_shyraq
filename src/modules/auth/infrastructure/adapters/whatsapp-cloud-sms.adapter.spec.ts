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
  otpTemplate: {
    name: 'otp_ru',
    language: 'ru',
    hasButton: true,
  },
  templates: {
    adminInvite: 'admin_invite_ru',
    staffInvite: 'staff_invite_ru',
    trustedPersonAssigned: 'trusted_person_assigned_ru',
    pickupOtp: 'pickup_otp_ru',
  },
  templateLanguage: 'ru',
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

  describe('sendOtp', () => {
    it('posts an authentication template with body and copy-code button when hasButton=true', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.otp' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      const result = await adapter.sendOtp('+7 (777) 227-00-88', '123456');

      expect(result.txnId).toBe('wamid.otp');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '77772270088',
        type: 'template',
        template: {
          name: 'otp_ru',
          language: { code: 'ru' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: '123456' }],
            },
          ],
        },
      });
    });

    it('omits the button component when hasButton=false', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.body-only' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(
        { ...config, otpTemplate: { ...config.otpTemplate, hasButton: false } },
        fetchImpl,
      );

      await adapter.sendOtp('77772270088', '999000');

      const payload = JSON.parse(calls[0].init.body as string);
      expect(payload.template.components).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: '999000' }] },
      ]);
    });

    it('honors a custom template name and language from config', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.kk' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(
        {
          ...config,
          otpTemplate: { name: 'otp_kk', language: 'kk', hasButton: true },
        },
        fetchImpl,
      );

      await adapter.sendOtp('77772270088', '424242');

      const payload = JSON.parse(calls[0].init.body as string);
      expect(payload.template.name).toBe('otp_kk');
      expect(payload.template.language).toEqual({ code: 'kk' });
    });

    it('reroutes the recipient when devRecipientOverride is set', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.otp-override' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(
        { ...config, devRecipientOverride: '787772270088' },
        fetchImpl,
      );

      await adapter.sendOtp('+77051112233', '111222');

      expect(JSON.parse(calls[0].init.body as string).to).toBe('787772270088');
    });

    it('throws when Meta rejects the template send', async () => {
      const { fetchImpl } = makeFetch([
        jsonResponse(400, {
          error: {
            message: 'Template name does not exist in the translation',
            type: 'OAuthException',
            code: 132001,
            fbtrace_id: 'XyZ',
          },
        }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      await expect(adapter.sendOtp('77772270088', '000111')).rejects.toThrow(
        /whatsapp_send_failed: 132001/,
      );
    });
  });

  describe('named-parameter templates', () => {
    it('sendAdminInvite posts the admin_invite_ru template with the kg_name named param', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.admin-invite' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      const result = await adapter.sendAdminInvite(
        '+7 (777) 227-00-88',
        'Балапан',
      );

      expect(result.txnId).toBe('wamid.admin-invite');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '77772270088',
        type: 'template',
        template: {
          name: 'admin_invite_ru',
          language: { code: 'ru' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', parameter_name: 'kg_name', text: 'Балапан' },
              ],
            },
          ],
        },
      });
    });

    it('sendStaffInvite posts the staff_invite_ru template with the kg_name named param', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.staff-invite' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      await adapter.sendStaffInvite('77772270088', 'Балапан');

      const payload = JSON.parse(calls[0].init.body as string);
      expect(payload.type).toBe('template');
      expect(payload.template.name).toBe('staff_invite_ru');
      expect(payload.template.components[0].parameters).toEqual([
        { type: 'text', parameter_name: 'kg_name', text: 'Балапан' },
      ]);
    });

    it('sendTrustedPersonAssigned posts both child_name and kg_name named params', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.trusted' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      await adapter.sendTrustedPersonAssigned(
        '77772270088',
        'Айгуль',
        'Балапан',
      );

      const payload = JSON.parse(calls[0].init.body as string);
      expect(payload.template.name).toBe('trusted_person_assigned_ru');
      expect(payload.template.components[0].parameters).toEqual([
        { type: 'text', parameter_name: 'child_name', text: 'Айгуль' },
        { type: 'text', parameter_name: 'kg_name', text: 'Балапан' },
      ]);
    });

    it('sendPickupOtp posts child_name, kg_name and otp named params', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.pickup-otp' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      const result = await adapter.sendPickupOtp(
        '+7 (777) 227-00-88',
        'Айгуль',
        'Балапан',
        '123456',
      );

      expect(result.txnId).toBe('wamid.pickup-otp');
      const payload = JSON.parse(calls[0].init.body as string);
      expect(payload.template.name).toBe('pickup_otp_ru');
      expect(payload.template.language).toEqual({ code: 'ru' });
      expect(payload.template.components[0].parameters).toEqual([
        { type: 'text', parameter_name: 'child_name', text: 'Айгуль' },
        { type: 'text', parameter_name: 'kg_name', text: 'Балапан' },
        { type: 'text', parameter_name: 'otp', text: '123456' },
      ]);
    });

    it('honors a custom template language from config', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.kk' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(
        { ...config, templateLanguage: 'kk' },
        fetchImpl,
      );

      await adapter.sendAdminInvite('77772270088', 'Балапан');

      const payload = JSON.parse(calls[0].init.body as string);
      expect(payload.template.language).toEqual({ code: 'kk' });
    });

    it('reroutes the recipient when devRecipientOverride is set', async () => {
      const { fetchImpl, calls } = makeFetch([
        jsonResponse(200, { messages: [{ id: 'wamid.override' }] }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(
        { ...config, devRecipientOverride: '787772270088' },
        fetchImpl,
      );

      await adapter.sendAdminInvite('+77051112233', 'Балапан');

      expect(JSON.parse(calls[0].init.body as string).to).toBe('787772270088');
    });

    it('throws when Meta rejects the template send', async () => {
      const { fetchImpl } = makeFetch([
        jsonResponse(400, {
          error: {
            message: 'Template name does not exist in the translation',
            type: 'OAuthException',
            code: 132001,
            fbtrace_id: 'XyZ',
          },
        }),
      ]);
      const adapter = new WhatsAppCloudSmsAdapter(config, fetchImpl);

      await expect(
        adapter.sendAdminInvite('77772270088', 'Балапан'),
      ).rejects.toThrow(/whatsapp_send_failed: 132001/);
    });
  });
});
