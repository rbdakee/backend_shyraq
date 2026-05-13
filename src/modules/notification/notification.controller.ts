import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { KindergartenScopeGuard } from '@/common/guards/kindergarten-scope.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { NotificationService } from './notification.service';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { ListNotificationsResponseDto } from './dto/list-notifications-response.dto';
import { MarkReadResponseDto } from './dto/mark-read-response.dto';
import { ReadAllResponseDto } from './dto/read-all-response.dto';
import { NotificationResponseDto } from './dto/notification-response.dto';
import type { NotificationRow } from './notification.repository';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException('tenant_required');
  return t.kgId;
}

function toDto(row: NotificationRow): NotificationResponseDto {
  return {
    id: row.id,
    event_key: row.eventKey,
    title_i18n: row.titleI18n,
    body_i18n: row.bodyI18n,
    data: row.data,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * Notification history endpoints. Tenant-scoped — requires
 * `KindergartenScopeGuard` + `TenantContextInterceptor` (global) so that RLS
 * `app.kindergarten_id` GUC is set for every query.
 *
 * Note on localization: `title_i18n` and `body_i18n` are returned as raw
 * JSONB objects (e.g. `{"ru": "...", "kk": "..."}`). Clients pick their
 * locale key. This avoids a per-request `UsersRepository` lookup while keeping
 * the payload fully locale-capable.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, KindergartenScopeGuard)
export class NotificationController {
  constructor(
    private readonly service: NotificationService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Paginated notification history for the authenticated user. ' +
      'Filtered to the current tenant via RLS. Cursor-based pagination using ' +
      'opaque base64 cursors. Returns raw title_i18n / body_i18n JSONB for ' +
      'client-side locale resolution.',
  })
  @ApiOkResponse({ type: ListNotificationsResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error or malformed cursor.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<ListNotificationsResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.listNotifications({
      kindergartenId: kgId,
      userId: user.sub,
      unreadOnly: query.unread_only ?? false,
      limit: query.limit ?? 20,
      cursor: query.cursor,
    });
    return {
      items: result.items.map(toDto),
      next_cursor: result.nextCursor,
    };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark all unread notifications for the current user in the current ' +
      'tenant as read. Idempotent.',
  })
  @ApiOkResponse({ type: ReadAllResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async readAll(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
  ): Promise<ReadAllResponseDto> {
    const kgId = requireTenant(t);
    const updated_count = await this.service.markAllRead(kgId, user.sub);
    return { updated_count };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark a single notification as read (read_at = NOW()). Only the owner ' +
      'can mark. 404 if not found or not owned.',
  })
  @ApiOkResponse({ type: MarkReadResponseDto })
  @ApiNotFoundResponse({ description: 'notification_not_found.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async markRead(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MarkReadResponseDto> {
    const kgId = requireTenant(t);
    const row = await this.service.markRead(kgId, id, user.sub);
    return {
      id: row.id,
      read_at: (row.readAt ?? this.clock.now()).toISOString(),
    };
  }
}
