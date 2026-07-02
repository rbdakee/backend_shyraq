import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { Payment, PaymentProvider } from './domain/entities/payment.entity';
import { WebhookSignatureInvalidError } from './domain/errors';
import { PaymentWebhookDto } from './dto/webhook.dto';
import { PaymentService } from './payment.service';

const KNOWN_PROVIDERS: ReadonlyArray<PaymentProvider> = [
  'mock',
  'halyk_epay',
  'kaspi_pay',
  'tiptoppay',
  'freedom_pay',
  'bcc',
  'cash',
] as const;

class WebhookAckDto {
  status!: 'ok';
}

/**
 * Cross-tenant payment webhook surface.
 *
 * Auth: `@Public()` — webhooks have no JWT. Per-provider signature
 * verification lives inside `PaymentService.processWebhook` →
 * `PaymentProviderPort.verifyWebhook(headers, body)`. The kg context is
 * resolved from the cross-tenant `(provider, provider_txn_id)` lookup, so
 * `KindergartenScopeGuard` cannot run here (no JWT).
 *
 * Response policy (B22a M2 refinement):
 * - **200** for known business outcomes: success, duplicate replay,
 *   unknown invoice / unknown payment-row, idempotent no-op. Providers
 *   should not retry — the request reached us and was processed.
 * - **400 `webhook_signature_invalid`** when the provider port rejects the
 *   signature. Surfacing the mismatch matches the documented contract
 *   (endpoints.md §4.5) and lets provider-side alerting fire on
 *   misconfiguration; previously this was swallowed as 200 which masked
 *   real signing-key drift between staging and prod.
 * - **200** for unexpected / unknown errors so providers don't enter
 *   exponential-backoff retry storms during a legitimate outage. The
 *   error is logged at ERROR level for ops triage. Idempotency at the
 *   service layer means a real provider replay after we recover settles
 *   correctly.
 *
 * Idempotency: handled at the service layer — replays of an already-
 * completed payment are a no-op.
 */
@ApiTags('Webhooks / Payments')
@Public()
@Controller({ path: 'webhooks/payments', version: '1' })
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(private readonly paymentService: PaymentService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Unified webhook endpoint. provider ∈ mock|halyk_epay|kaspi_pay|tiptoppay|freedom_pay|bcc. Returns 200 for known business outcomes (success / duplicate / unknown invoice). Returns 400 webhook_signature_invalid when the provider port rejects the signature so misconfiguration fires provider-side alerts.',
  })
  @ApiBody({ type: PaymentWebhookDto })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiBadRequestResponse({
    description:
      'Signature verification failed — body/headers do not match the configured provider secret.',
    schema: {
      example: {
        statusCode: 400,
        error: 'webhook_signature_invalid',
        message: 'webhook_signature_invalid',
        details: { provider: 'halyk_epay' },
      },
    },
  })
  async webhook(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    // @Req() is used instead of @Body() to bypass the global
    // ValidationPipe's `whitelist: true` which would strip ALL properties
    // from `PaymentWebhookDto` (index-signature only, no decorated fields).
    // Provider payloads are arbitrary JSON validated by `verifyWebhook`;
    // stripping properties here would break signature verification.
    @Req() req: RawBodyRequest<Request>,
  ): Promise<WebhookAckDto> {
    const body = req.body as PaymentWebhookDto;
    if (!isKnownProvider(provider)) {
      // Don't 404 — provider integrations may probe new paths during
      // onboarding and we'd rather log and ack than trigger retry storms.
      this.logger.warn(
        `payments.webhook: unknown provider="${provider}" — acked, no action`,
      );
      return { status: 'ok' };
    }
    try {
      await this.paymentService.processWebhook({
        provider: provider as PaymentProvider,
        headers,
        body,
        rawBody: req.rawBody,
      });
      return { status: 'ok' };
    } catch (err) {
      // M2 (B22a): signature mismatch propagates as 400 so a misconfigured
      // provider integration fails loudly. Audit-log the mismatch with
      // provider + header keys (NOT values — signature secrets must not
      // hit application logs).
      if (err instanceof WebhookSignatureInvalidError) {
        const headerKeys = Object.keys(headers).sort().join(',');
        this.logger.warn(
          `payments.webhook: signature mismatch provider=${provider} headers=[${headerKeys}]`,
        );
        throw err;
      }
      // 200-on-other-errors: provider must not retry on app-side failures.
      // The alternative — letting NestJS surface 5xx — would invite
      // providers like Halyk to enter exponential-backoff retry loops that
      // hammer our DB during a legitimate outage. Idempotency at the
      // service layer means a real provider replay after we recover will
      // settle correctly.
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `payments.webhook: provider=${provider} processing failed: ${message}`,
        stack,
      );
      return { status: 'ok' };
    }
  }
}

function isKnownProvider(p: string): p is PaymentProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(p);
}

// Surface Payment domain in scope so tooling that walks barrel exports
// keeps the symbol traceable even though the controller does not return
// the entity directly.
export type { Payment };
