import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import {
  BccAccountProvisioningResponseDto,
  BccAccountResponseDto,
  BccCallbackCredentialsResponseDto,
  BccConnectionCheckResponseDto,
  BccDisableResponseDto,
  RotateBccMacDto,
  UpsertBccAccountDto,
} from './dto/saas-bcc-account.dto';
import {
  BccAccountView,
  BccMerchantOnboardingService,
} from './bcc-merchant-onboarding.service';

@ApiTags('SaaS / BCC')
@ApiBearerAuth()
@Controller({
  path: 'saas/kindergartens/:kindergartenId/bcc/account',
  version: '1',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@SuperAdminScope()
@Roles('super_admin', 'support')
export class SaasBccAccountController {
  constructor(private readonly service: BccMerchantOnboardingService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create or update a draft BCC merchant account.' })
  @ApiParam({ name: 'kindergartenId', format: 'uuid' })
  @ApiOkResponse({ type: BccAccountProvisioningResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing or invalid.' })
  @ApiForbiddenResponse({ description: 'Caller is not a SaaS operator.' })
  @ApiNotFoundResponse({ description: 'kindergarten_not_found.' })
  @ApiConflictResponse({ description: 'bcc_account_active.' })
  @ApiUnprocessableEntityResponse({
    description: 'Validation error or bcc_mac_components_invalid.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async upsert(
    @Param('kindergartenId', new ParseUUIDPipe()) kindergartenId: string,
    @Body() body: UpsertBccAccountDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<BccAccountProvisioningResponseDto> {
    const result = await this.service.upsert(
      kindergartenId,
      {
        merchantId: body.merchant_id,
        terminalId: body.terminal_id,
        merchantName: body.merchant_name ?? null,
        environment: body.environment,
        macKeyComponent1: body.mac_key_component_1,
        macKeyComponent2: body.mac_key_component_2,
      },
      user.sub,
    );
    return {
      ...presentAccount(result.account),
      ...(result.callbackCredentials
        ? {
            notify_url: result.callbackCredentials.notifyUrl,
            notify_username: result.callbackCredentials.notifyUsername,
            notify_password: result.callbackCredentials.notifyPassword,
          }
        : {}),
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Read BCC account status without secrets.' })
  @ApiParam({ name: 'kindergartenId', format: 'uuid' })
  @ApiOkResponse({ type: BccAccountResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing or invalid.' })
  @ApiForbiddenResponse({ description: 'Caller is not a SaaS operator.' })
  @ApiNotFoundResponse({ description: 'bcc_account_not_found.' })
  @ApiConflictResponse({ description: 'State conflict.' })
  @ApiUnprocessableEntityResponse({ description: 'Validation error.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async get(
    @Param('kindergartenId', new ParseUUIDPipe()) kindergartenId: string,
  ): Promise<BccAccountResponseDto> {
    return presentAccount(await this.service.get(kindergartenId));
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run BCC TRTYPE=800 and activate the account on success.',
  })
  @ApiParam({ name: 'kindergartenId', format: 'uuid' })
  @ApiOkResponse({ type: BccConnectionCheckResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing or invalid.' })
  @ApiForbiddenResponse({ description: 'Caller is not a SaaS operator.' })
  @ApiNotFoundResponse({ description: 'bcc_account_not_found.' })
  @ApiConflictResponse({ description: 'Invalid account state.' })
  @ApiUnprocessableEntityResponse({ description: 'Validation error.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  @ApiBadGatewayResponse({
    description: 'bcc_gateway_unavailable or bcc_connection_check_failed.',
  })
  async check(
    @Param('kindergartenId', new ParseUUIDPipe()) kindergartenId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<BccConnectionCheckResponseDto> {
    const result = await this.service.checkConnection(kindergartenId, user.sub);
    return {
      connected: result.connected,
      status: result.status,
      checked_at: result.checkedAt.toISOString(),
      result: {
        success: result.result.success,
        action: result.result.action,
        rc: result.result.rc,
        rc_text: result.result.rcText,
      },
    };
  }

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable new BCC payments without deleting history.',
  })
  @ApiParam({ name: 'kindergartenId', format: 'uuid' })
  @ApiOkResponse({ type: BccDisableResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing or invalid.' })
  @ApiForbiddenResponse({ description: 'Caller is not a SaaS operator.' })
  @ApiNotFoundResponse({ description: 'bcc_account_not_found.' })
  @ApiConflictResponse({ description: 'Invalid account state.' })
  @ApiUnprocessableEntityResponse({ description: 'Validation error.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async disable(
    @Param('kindergartenId', new ParseUUIDPipe()) kindergartenId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<BccDisableResponseDto> {
    return this.service.disable(kindergartenId, user.sub);
  }

  @Post('rotate-mac')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the encrypted MAC key and require a new connection check.',
  })
  @ApiParam({ name: 'kindergartenId', format: 'uuid' })
  @ApiOkResponse({ type: BccAccountResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing or invalid.' })
  @ApiForbiddenResponse({ description: 'Caller is not a SaaS operator.' })
  @ApiNotFoundResponse({ description: 'bcc_account_not_found.' })
  @ApiConflictResponse({ description: 'Invalid account state.' })
  @ApiUnprocessableEntityResponse({
    description: 'Validation error or bcc_mac_components_invalid.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async rotateMac(
    @Param('kindergartenId', new ParseUUIDPipe()) kindergartenId: string,
    @Body() body: RotateBccMacDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<BccAccountResponseDto> {
    return presentAccount(
      await this.service.rotateMac(
        kindergartenId,
        body.mac_key_component_1,
        body.mac_key_component_2,
        user.sub,
      ),
    );
  }

  @Post('rotate-callback-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate callback token and Basic credentials; return them once.',
  })
  @ApiParam({ name: 'kindergartenId', format: 'uuid' })
  @ApiOkResponse({ type: BccCallbackCredentialsResponseDto })
  @ApiBadRequestResponse({ description: 'Malformed request.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing or invalid.' })
  @ApiForbiddenResponse({ description: 'Caller is not a SaaS operator.' })
  @ApiNotFoundResponse({ description: 'bcc_account_not_found.' })
  @ApiConflictResponse({ description: 'Invalid account state.' })
  @ApiUnprocessableEntityResponse({ description: 'Validation error.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async rotateCallbackCredentials(
    @Param('kindergartenId', new ParseUUIDPipe()) kindergartenId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<BccCallbackCredentialsResponseDto> {
    const result = await this.service.rotateCallbackCredentials(
      kindergartenId,
      user.sub,
    );
    return {
      notify_url: result.notifyUrl,
      notify_username: result.notifyUsername,
      notify_password: result.notifyPassword,
    };
  }
}

function presentAccount(account: BccAccountView): BccAccountResponseDto {
  return {
    connected: account.connected,
    status: account.status,
    merchant_id: account.merchantId,
    terminal_id: account.terminalId,
    merchant_name: account.merchantName,
    environment: account.environment,
    last_connection_checked_at:
      account.lastConnectionCheckedAt?.toISOString() ?? null,
    last_connection_result: account.lastConnectionResult
      ? {
          success: account.lastConnectionResult.success,
          action: account.lastConnectionResult.action,
          rc: account.lastConnectionResult.rc,
          rc_text: account.lastConnectionResult.rcText,
        }
      : null,
  };
}
