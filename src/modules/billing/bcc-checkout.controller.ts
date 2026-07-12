import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import {
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '@/common/decorators/public.decorator';
import { BccCheckoutService } from './bcc-checkout.service';
import { resolveBccClientIp } from './infrastructure/checkout/bcc-client-ip';

@ApiTags('Payments / BCC Checkout')
@Public()
@Controller({ path: 'payments/bcc', version: '1' })
export class BccCheckoutController {
  constructor(private readonly checkout: BccCheckoutService) {}

  @Get('checkout/:token')
  @ApiOperation({
    summary:
      'Consume a one-time BCC checkout token and POST the signed form from the WebView.',
  })
  @ApiOkResponse({ description: 'Self-submitting HTML checkout bridge.' })
  @ApiGoneResponse({ description: 'bcc_checkout_expired' })
  async open(
    @Param('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const page = await this.checkout.consume(
      token,
      resolveBccClientIp(request),
    );
    sendNoStoreHtml(response, page.html, page.contentSecurityPolicy);
  }

  @Get('return')
  @ApiOperation({
    summary:
      'Neutral BACKREF page. It never treats the browser return as payment success.',
  })
  @ApiOkResponse({ description: 'Processing HTML page.' })
  return(@Res() response: Response): void {
    const page = this.checkout.renderReturn();
    sendNoStoreHtml(response, page.html, page.contentSecurityPolicy);
  }
}

function sendNoStoreHtml(
  response: Response,
  html: string,
  contentSecurityPolicy: string,
): void {
  response
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Cache-Control', 'no-store, max-age=0')
    .setHeader('Pragma', 'no-cache')
    .setHeader('Content-Security-Policy', contentSecurityPolicy)
    .setHeader('Referrer-Policy', 'no-referrer')
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    .send(html);
}
