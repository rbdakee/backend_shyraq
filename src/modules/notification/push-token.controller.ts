import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { NotificationService } from './notification.service';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { PushTokenResponseDto } from './dto/push-token-response.dto';

/**
 * User-scoped push-token endpoints.
 * No `KindergartenScopeGuard` — `push_tokens` is a global table (no RLS).
 * Any authenticated user (parent / staff / admin / super-admin) may register
 * or unregister a device token.
 */
@ApiTags('Push Tokens')
@ApiBearerAuth()
@Controller({ path: 'push-tokens', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
export class PushTokenController {
  constructor(private readonly service: NotificationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Register (or refresh) a device push token. ' +
      'Upsert on (user_id, token) — re-registering the same token updates ' +
      'last_seen_at, app_version, and device_id.',
  })
  @ApiCreatedResponse({
    type: PushTokenResponseDto,
    description: 'Token registered / updated.',
  })
  @ApiBadRequestResponse({
    description: 'Validation error (missing token, invalid platform).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async register(
    @CurrentUser() user: JwtPayload,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<PushTokenResponseDto> {
    const token = await this.service.registerPushToken(user.sub, {
      token: dto.token,
      platform: dto.platform,
      appVersion: dto.app_version ?? null,
      deviceId: dto.device_id ?? null,
    });
    return {
      id: token.id,
      user_id: token.userId,
      token: token.token,
      platform: token.platform,
      app_version: token.appVersion,
      device_id: token.deviceId,
      last_seen_at: token.lastSeenAt.toISOString(),
      created_at: token.createdAt.toISOString(),
    };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Unregister a push token. Only the owner (matching user_id) can ' +
      'delete. Returns 404 if not found or owned by a different user.',
  })
  @ApiNoContentResponse({ description: 'Token successfully unregistered.' })
  @ApiNotFoundResponse({ description: 'push_token_not_found.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async unregister(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.service.deletePushToken(id, user.sub);
  }
}
