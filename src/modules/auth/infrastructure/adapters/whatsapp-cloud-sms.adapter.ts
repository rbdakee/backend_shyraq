import { Injectable, Logger } from '@nestjs/common';
import { SmsPort, SmsSendResult } from '../../sms.port';
import { WhatsAppConfig } from '../../config/auth-config.type';

export type WhatsAppCloudFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

interface WhatsAppApiResponse {
  messaging_product?: string;
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/**
 * WhatsApp Cloud API adapter for SmsPort. Supports two delivery modes:
 *
 *   - `send(phone, message)` — freeform `text` body via Meta Graph API.
 *     Requires an open 24-hour customer service window (recipient must have
 *     messaged the WABA number within the last 24h). Outside that window
 *     Meta rejects with error code 131047. Used for welcome / non-OTP
 *     messages where cold delivery is not required.
 *
 *   - `sendOtp(phone, code)` — pre-approved Authentication-category template
 *     (default `otp_ru`). Bypasses the 24h window — required for OTPs that
 *     must reach cold recipients (trusted persons, first-time logins).
 *     Template name/language/button presence is configurable via
 *     WHATSAPP_OTP_TEMPLATE_* env vars.
 *
 * `devRecipientOverride` is a sandbox-only escape hatch — see the comment on
 * `WhatsAppConfig.devRecipientOverride` and the README of env-example for the
 * specific Meta dashboard bug it works around.
 */
@Injectable()
export class WhatsAppCloudSmsAdapter extends SmsPort {
  private readonly logger = new Logger(WhatsAppCloudSmsAdapter.name);
  private readonly endpoint: string;
  private readonly fetchImpl: WhatsAppCloudFetch;

  constructor(
    private readonly config: WhatsAppConfig,
    fetchImpl?: WhatsAppCloudFetch,
  ) {
    super();
    this.endpoint = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`;
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => globalThis.fetch(input as RequestInfo, init));
    if (config.devRecipientOverride) {
      this.logger.warn(
        `DEV RECIPIENT OVERRIDE ACTIVE — every outgoing WhatsApp message will be re-routed to ${maskPhone(config.devRecipientOverride)}. NEVER enable in production.`,
      );
    }
  }

  async send(phone: string, message: string): Promise<SmsSendResult> {
    const to = this.resolveRecipient(phone);
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    };
    return this.post(body, to, 'text');
  }

  async sendOtp(phone: string, code: string): Promise<SmsSendResult> {
    const to = this.resolveRecipient(phone);
    const tpl = this.config.otpTemplate;
    const components: Array<Record<string, unknown>> = [
      {
        type: 'body',
        parameters: [{ type: 'text', text: code }],
      },
    ];
    if (tpl.hasButton) {
      // Meta Authentication-template button (sub_type `url` for one-tap
      // auto-fill, also works for the copy-code variant). Index is a string
      // per the API contract.
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      });
    }
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: tpl.name,
        language: { code: tpl.language },
        components,
      },
    };
    return this.post(body, to, `template:${tpl.name}`);
  }

  private resolveRecipient(phone: string): string {
    const realRecipient = normalizeRecipient(phone);
    const to = this.config.devRecipientOverride ?? realRecipient;
    if (to !== realRecipient) {
      this.logger.warn(
        `WhatsApp dev-override: original=${maskPhone(realRecipient)} → override=${maskPhone(to)}`,
      );
    }
    return to;
  }

  private async post(
    body: Record<string, unknown>,
    to: string,
    kind: string,
  ): Promise<SmsSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`WhatsApp ${kind} send failed (network): ${reason}`);
      throw new Error(`whatsapp_send_failed: ${reason}`);
    }

    const json = (await safeJson(response)) as WhatsAppApiResponse | null;

    if (!response.ok || json?.error) {
      const errCode = json?.error?.code ?? response.status;
      const errMsg = json?.error?.message ?? response.statusText;
      const trace = json?.error?.fbtrace_id ?? '-';
      this.logger.error(
        `WhatsApp ${kind} rejected: status=${response.status} code=${errCode} fbtrace=${trace} msg="${errMsg}" to=${maskPhone(to)}`,
      );
      throw new Error(`whatsapp_send_failed: ${errCode} ${errMsg}`);
    }

    const messageId = json?.messages?.[0]?.id;
    if (!messageId) {
      this.logger.error(
        `WhatsApp ${kind} returned 2xx but no message id: ${JSON.stringify(json)}`,
      );
      throw new Error('whatsapp_send_failed: missing message id');
    }

    this.logger.log(
      `WhatsApp sent (${kind}): to=${maskPhone(to)} message_id=${messageId}`,
    );
    return { txnId: messageId };
  }
}

function normalizeRecipient(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}
