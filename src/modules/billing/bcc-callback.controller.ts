import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { PaymentService } from './payment.service';

@ApiTags('Webhooks / Payments')
@Public()
@Controller({ path: 'webhooks/payments/bcc', version: '1' })
export class BccCallbackController {
  constructor(private readonly payments: PaymentService) {}

  @Post(':callbackToken')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('application/x-www-form-urlencoded')
  @ApiOperation({ summary: 'Receive an authenticated BCC URL notification' })
  @ApiOkResponse({ schema: { example: 'OK' } })
  @ApiBadRequestResponse({ description: 'Malformed or mismatched callback' })
  @ApiUnauthorizedResponse({ description: 'Invalid callback credentials' })
  async callback(
    @Param('callbackToken') callbackToken: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<'OK'> {
    const mediaType = String(headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/x-www-form-urlencoded') {
      throw new UnsupportedMediaTypeException(
        'bcc_callback_content_type_invalid',
      );
    }
    await this.payments.processWebhook({
      provider: 'bcc',
      headers,
      body: req.body,
      rawBody: req.rawBody,
      callbackToken,
    });
    response.type('text/plain');
    return 'OK';
  }
}
