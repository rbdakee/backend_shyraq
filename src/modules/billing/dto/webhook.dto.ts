/**
 * PaymentWebhookDto — accepts arbitrary JSON body from any payment provider.
 *
 * The body shape varies per provider (Halyk ePay, Kaspi Pay, TipTopPay,
 * FreedomPay, Mock). Validation is handled inside the service layer via
 * `PaymentProviderPort.verifyWebhook(headers, body)` rather than
 * class-validator. The class is kept here only so the controller can declare
 * a typed @Body() parameter and for Swagger documentation purposes.
 *
 * Controller usage:
 *   @Post('/webhooks/payments/:provider')
 *   @ApiBody({ type: PaymentWebhookDto })
 *   async handleWebhook(@Param('provider') provider: string, @Body() body: PaymentWebhookDto) { ... }
 */
export class PaymentWebhookDto {
  [key: string]: unknown;
}
