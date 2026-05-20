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
 * WhatsApp Cloud API adapter for SmsPort. Sends freeform `text` messages via
 * Meta Graph API. Freeform requires an open 24-hour customer service window
 * — the recipient must have messaged the WhatsApp Business number within the
 * last 24h. Outside that window Meta rejects with error code 131047 and a
 * pre-approved template is required.
 *
 * Template-based delivery is not implemented yet. Once the business account
 * is verified and an Authentication template is approved, extend this
 * adapter with a template path so OTP delivery works without depending on
 * the 24h window.
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
    const realRecipient = normalizeRecipient(phone);
    const to = this.config.devRecipientOverride ?? realRecipient;
    if (to !== realRecipient) {
      this.logger.warn(
        `WhatsApp dev-override: original=${maskPhone(realRecipient)} → override=${maskPhone(to)}`,
      );
    }
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    };

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
      this.logger.error(`WhatsApp send failed (network): ${reason}`);
      throw new Error(`whatsapp_send_failed: ${reason}`);
    }

    const json = (await safeJson(response)) as WhatsAppApiResponse | null;

    if (!response.ok || json?.error) {
      const errCode = json?.error?.code ?? response.status;
      const errMsg = json?.error?.message ?? response.statusText;
      const trace = json?.error?.fbtrace_id ?? '-';
      this.logger.error(
        `WhatsApp send rejected: status=${response.status} code=${errCode} fbtrace=${trace} msg="${errMsg}" to=${maskPhone(to)}`,
      );
      throw new Error(`whatsapp_send_failed: ${errCode} ${errMsg}`);
    }

    const messageId = json?.messages?.[0]?.id;
    if (!messageId) {
      this.logger.error(
        `WhatsApp send returned 2xx but no message id: ${JSON.stringify(json)}`,
      );
      throw new Error('whatsapp_send_failed: missing message id');
    }

    this.logger.log(
      `WhatsApp sent: to=${maskPhone(to)} message_id=${messageId}`,
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
