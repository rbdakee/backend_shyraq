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
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { Payment, PaymentProvider } from './domain/entities/payment.entity';
import { PaymentWebhookDto } from './dto/webhook.dto';
import { PaymentService } from './payment.service';

const KNOWN_PROVIDERS: ReadonlyArray<PaymentProvider> = [
  'mock',
  'halyk_epay',
  'kaspi_pay',
  'tiptoppay',
  'freedom_pay',
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
 * Response policy: **always 200** when the request reached us — this
 * prevents provider-side retry storms. Signature mismatches are the one
 * exception that surface as 4xx so a misconfigured provider integration
 * fails loudly during development. Unknown providers and arbitrary
 * processing errors are logged + acked.
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
      'Unified webhook endpoint. provider ∈ mock|halyk_epay|kaspi_pay|tiptoppay|freedom_pay. Returns 200 always (idempotent); 4xx is reserved for signature mismatch surfaced by the provider port.',
  })
  @ApiBody({ type: PaymentWebhookDto })
  @ApiOkResponse({ type: WebhookAckDto })
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
      // 200-always: provider must not retry on app-side failures (signature
      // verification handles its own loud failure path inside
      // PaymentProviderPort + falls through here as a logged error). The
      // alternative — letting NestJS surface 5xx — would invite providers
      // like Halyk to enter exponential-backoff retry loops that hammer
      // our DB during a legitimate outage. Idempotency at the service
      // layer means a real provider replay after we recover will settle
      // correctly.
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
