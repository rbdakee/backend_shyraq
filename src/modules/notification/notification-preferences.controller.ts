import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { NotificationService } from './notification.service';
import { ListPreferencesResponseDto } from './dto/list-preferences-response.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

/**
 * Notification preference endpoints. User-scoped (global table, no RLS).
 * Returns one entry per canonical event key — missing DB rows use defaults
 * `push_enabled=true, in_app_enabled=true`.
 */
@ApiTags('Notification Preferences')
@ApiBearerAuth()
@Controller({ path: 'notifications/preferences', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
export class NotificationPreferencesController {
  constructor(private readonly service: NotificationService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Return notification preferences for the authenticated user. ' +
      'One entry per canonical event key. Rows without a DB record default ' +
      'to push_enabled=true, in_app_enabled=true.',
  })
  @ApiOkResponse({ type: ListPreferencesResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async list(
    @CurrentUser() user: JwtPayload,
  ): Promise<ListPreferencesResponseDto> {
    return this.service.listPreferences(user.sub);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Upsert notification preferences. Partial per-entry: only supplied ' +
      'flags are changed. Unknown event_key values are rejected (400). ' +
      'Returns the full updated preference set.',
  })
  @ApiOkResponse({ type: ListPreferencesResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error or invalid_event_key (unknown event_key).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async update(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<ListPreferencesResponseDto> {
    return this.service.updatePreferences(user.sub, dto);
  }
}
