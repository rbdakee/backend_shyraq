import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { AddKindergartenAdminDto } from './dto/add-kindergarten-admin.dto';
import { CreateKindergartenDto } from './dto/create-kindergarten.dto';
import { InviteAdminDto } from './dto/invite-admin.dto';
import {
  AddKindergartenAdminResponseDto,
  CreateKindergartenResponseDto,
  InviteAdminResponseDto,
  KindergartenAdminDto,
  KindergartenDto,
  KindergartenListResponseDto,
} from './dto/kindergarten-response.dto';
import { ListKindergartenAdminsQueryDto } from './dto/list-kindergarten-admins-query.dto';
import { ListKindergartensQueryDto } from './dto/list-kindergartens-query.dto';
import { KindergartenPresenter } from './kindergarten.presenter';
import { KindergartenService } from './kindergarten.service';

/**
 * SaaS-operator kindergarten surface. `@SuperAdminScope()` makes
 * `KindergartenScopeGuard` accept callers without an `admin` kg-binding and
 * makes `TenantContextInterceptor` switch the wrapping transaction to
 * `SET LOCAL app.bypass_rls = 'true'` so cross-tenant inserts/updates work.
 */
@ApiTags('Kindergartens (SuperAdmin)')
@ApiBearerAuth()
@Controller({ path: 'saas/kindergartens', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@SuperAdminScope()
@Roles('super_admin', 'support')
export class SuperAdminKindergartenController {
  constructor(private readonly service: KindergartenService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a kindergarten + first admin atomically.',
    description:
      'One request-scoped transaction inserts the kindergarten, finds-or-creates the user by phone, and links them via a staff_members row with role=admin. Best-effort welcome SMS afterwards.',
  })
  @ApiBody({
    type: CreateKindergartenDto,
    examples: {
      minimal: {
        summary: 'Minimal valid payload',
        value: {
          name: 'Солнышко',
          slug: 'solnyshko',
          admin: {
            full_name: 'Айгерим Нурланкызы',
            phone: '+77011112233',
            locale: 'ru',
          },
        },
      },
      full: {
        summary: 'With address, phone, plan, settings',
        value: {
          name: 'Солнышко',
          slug: 'solnyshko-1',
          address: 'Алматы, ул. Абая, 1',
          phone: '+77272221100',
          plan: 'standard',
          settings: { timezone: 'Asia/Almaty', currency: 'KZT' },
          admin: {
            full_name: 'Айгерим Нурланкызы',
            phone: '+77011112234',
            locale: 'ru',
          },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: CreateKindergartenResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid slug or phone format (`invariant_violation`).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  @ApiConflictResponse({
    description: 'Slug already taken (`kindergarten_slug_taken`).',
  })
  async create(
    @Body() dto: CreateKindergartenDto,
  ): Promise<CreateKindergartenResponseDto> {
    const created = await this.service.createKindergarten({
      name: dto.name,
      slug: dto.slug,
      address: dto.address ?? null,
      phone: dto.phone ?? null,
      plan: dto.plan,
      settings: dto.settings,
      admin: {
        fullName: dto.admin.full_name,
        phone: dto.admin.phone,
        locale: dto.admin.locale,
      },
    });
    return KindergartenPresenter.createdWithAdmin(created);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List kindergartens with optional filters and pagination.',
  })
  @ApiOkResponse({ type: KindergartenListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  async list(
    @Query() query: ListKindergartensQueryDto,
  ): Promise<KindergartenListResponseDto> {
    const result = await this.service.listKindergartens({
      plan: query.plan,
      isActive: query.is_active,
      archived: query.archived,
      nameSearch: query.name_search,
      limit: query.limit,
      offset: query.offset,
    });
    return KindergartenPresenter.list(result);
  }

  @Post(':id/admin/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send an admin invite SMS for the given kindergarten.',
    description:
      'Best-effort: returns 200 even when the SMS adapter fails (`sent: false`). Useful for re-inviting an admin who lost their device.',
  })
  @ApiParam({ name: 'id', example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  @ApiBody({ type: InviteAdminDto })
  @ApiOkResponse({ type: InviteAdminResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid phone (`invariant_violation`).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  @ApiNotFoundResponse({
    description: 'Kindergarten not found (`kindergarten_not_found`).',
  })
  @ApiConflictResponse({
    description: 'Kindergarten archived (`kindergarten_archived`).',
  })
  async inviteAdmin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InviteAdminDto,
  ): Promise<InviteAdminResponseDto> {
    const result = await this.service.inviteAdmin(id, dto.phone);
    return {
      phone: result.phone,
      kindergarten_id: result.kindergartenId,
      sent: result.sent,
    };
  }

  @Get(':id/admins')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List admins of a kindergarten.',
    description:
      'Returns a plain array (NOT offset-paginated) of staff_members with role=admin for the kindergarten. Optional `is_active` filter; omit it to return ALL admins (active + deactivated). full_name/phone/locale are resolved from the linked users row.',
  })
  @ApiParam({ name: 'id', example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  @ApiOkResponse({ type: [KindergartenAdminDto] })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing/invalid/revoked.',
    schema: {
      example: { statusCode: 401, message: 'Unauthorized' },
    },
  })
  @ApiForbiddenResponse({
    description: 'Caller is not super_admin/support.',
    schema: {
      example: { statusCode: 403, message: 'Forbidden resource' },
    },
  })
  @ApiNotFoundResponse({
    description: 'Kindergarten not found.',
    schema: {
      example: {
        statusCode: 404,
        error: 'kindergarten_not_found',
        message: 'kindergarten_not_found',
      },
    },
  })
  async listAdmins(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListKindergartenAdminsQueryDto,
  ): Promise<KindergartenAdminDto[]> {
    const rows = await this.service.listAdmins(id, query.is_active);
    return KindergartenPresenter.adminList(rows);
  }

  @Post(':id/admins')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add another admin to an existing kindergarten.',
    description:
      'Find-or-create user by phone (existing identity untouched), then a staff_members row with role=admin. Strict 409 if ANY staff row already exists for the (kg, user) pair regardless of is_active. Best-effort invite SMS afterwards.',
  })
  @ApiParam({ name: 'id', example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  @ApiBody({
    type: AddKindergartenAdminDto,
    examples: {
      minimal: {
        summary: 'Minimal valid payload',
        value: { full_name: 'Жанна Серикова', phone: '+77011115566' },
      },
      withLocale: {
        summary: 'With explicit locale',
        value: {
          full_name: 'Жанна Серикова',
          phone: '+77011115566',
          locale: 'kk',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AddKindergartenAdminResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid phone/locale format (`invariant_violation`).',
  })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing/invalid/revoked.',
    schema: { example: { statusCode: 401, message: 'Unauthorized' } },
  })
  @ApiForbiddenResponse({
    description: 'Caller is not super_admin/support.',
    schema: { example: { statusCode: 403, message: 'Forbidden resource' } },
  })
  @ApiNotFoundResponse({
    description: 'Kindergarten not found (`kindergarten_not_found`).',
    schema: {
      example: {
        statusCode: 404,
        error: 'kindergarten_not_found',
        message: 'kindergarten_not_found',
      },
    },
  })
  @ApiConflictResponse({
    description:
      'Kindergarten archived (`kindergarten_archived`), or an admin (`admin_already_exists`) / non-admin staff (`staff_already_exists`) row already exists for the (kg, user) pair.',
    schema: {
      example: {
        statusCode: 409,
        error: 'admin_already_exists',
        message: 'admin_already_exists',
      },
    },
  })
  async addAdmin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddKindergartenAdminDto,
  ): Promise<AddKindergartenAdminResponseDto> {
    const added = await this.service.addAdmin(id, {
      fullName: dto.full_name,
      phone: dto.phone,
      locale: dto.locale,
    });
    return KindergartenPresenter.addedAdmin(added);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Soft-delete a kindergarten + deactivate all its staff rows.',
    description:
      'Sets archived_at + is_active=false, then bulk-deactivates every staff_members row for the tenant. Idempotent — re-archiving returns the row unchanged.',
  })
  @ApiParam({ name: 'id', example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  @ApiOkResponse({ type: KindergartenDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  @ApiNotFoundResponse({
    description: 'Kindergarten not found (`kindergarten_not_found`).',
  })
  async archive(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<KindergartenDto> {
    const archived = await this.service.archiveKindergarten(id);
    return KindergartenPresenter.kindergarten(archived);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore an archived kindergarten.',
    description:
      'Clears archived_at and sets is_active=true. Staff rows are NOT auto-reactivated — operators re-enable individual admins through the staff endpoints (P4). Idempotent for already-active rows.',
  })
  @ApiParam({ name: 'id', example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  @ApiOkResponse({ type: KindergartenDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  @ApiNotFoundResponse({
    description: 'Kindergarten not found (`kindergarten_not_found`).',
  })
  async restore(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<KindergartenDto> {
    const restored = await this.service.restoreKindergarten(id);
    return KindergartenPresenter.kindergarten(restored);
  }
}
