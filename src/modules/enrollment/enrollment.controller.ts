import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AssignEnrollmentDto } from './dto/assign-enrollment.dto';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { EnrollmentDetailResponseDto } from './dto/enrollment-status-log.response.dto';
import {
  EnrollmentListResponseDto,
  EnrollmentResponseDto,
} from './dto/enrollment.response.dto';
import { ListEnrollmentsQuery } from './dto/list-enrollments.query';
import { TransitionEnrollmentDto } from './dto/transition-enrollment.dto';
import { UpdateEnrollmentDto } from './dto/update-enrollment.dto';
import { EnrollmentPresenter } from './enrollment.presenter';
import { EnrollmentService } from './enrollment.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-scoped endpoints for enrollment leads (B5). Protected by the global
 * guard chain (JwtAuthGuard → PendingRoleSelectGuard → RolesGuard) and the
 * TenantContextInterceptor that pins `app.kindergarten_id` for the duration
 * of the handler. Role enforcement via `@Roles('admin')`.
 */
@ApiTags('Admin / Enrollments')
@ApiBearerAuth()
@Controller({ path: 'admin/enrollments', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class EnrollmentController {
  constructor(private readonly service: EnrollmentService) {}

  @Get()
  @ApiOperation({
    summary: 'List enrollment leads with filters and pagination.',
  })
  @ApiOkResponse({ type: EnrollmentListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListEnrollmentsQuery,
  ): Promise<EnrollmentListResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.list(kgId, query);
    return {
      data: result.items.map((e) => EnrollmentPresenter.toResponseDto(e)),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an enrollment lead.' })
  @ApiCreatedResponse({ type: EnrollmentResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Assigned staff member not found.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    const kgId = requireTenant(t);
    const enrollment = await this.service.create(
      kgId,
      {
        contactName: dto.contactName,
        contactPhone: dto.contactPhone,
        childName: dto.childName,
        childDob: dto.childDob ? new Date(dto.childDob) : undefined,
        childIin: dto.childIin,
        source: dto.source,
        notes: dto.notes,
        assignedTo: dto.assignedTo,
      },
      user.sub,
    );
    return EnrollmentPresenter.toResponseDto(enrollment);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get enrollment with full status-change log.' })
  @ApiOkResponse({ type: EnrollmentDetailResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Enrollment not found.' })
  async getById(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<EnrollmentDetailResponseDto> {
    const kgId = requireTenant(t);
    const { enrollment, log } = await this.service.getById(kgId, id);
    return {
      enrollment: EnrollmentPresenter.toResponseDto(enrollment),
      log: log.map((e) => EnrollmentPresenter.toLogResponseDto(e)),
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update enrollment lead fields (partial).' })
  @ApiOkResponse({ type: EnrollmentResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Enrollment not found.' })
  @ApiConflictResponse({
    description:
      'Enrollment locked — status is card_created, cancelled, or archive.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    const kgId = requireTenant(t);
    const enrollment = await this.service.update(kgId, id, {
      contactName: dto.contactName,
      contactPhone: dto.contactPhone,
      childName: dto.childName,
      childDob: dto.childDob ? new Date(dto.childDob) : undefined,
      childIin: dto.childIin,
      source: dto.source,
      notes: dto.notes,
      assignedTo: dto.assignedTo,
    });
    return EnrollmentPresenter.toResponseDto(enrollment);
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transition enrollment status along the state machine.',
  })
  @ApiOkResponse({
    description:
      'Returns the updated enrollment and, when toStatus is card_created, the newly created child record.',
    schema: {
      properties: {
        enrollment: { $ref: '#/components/schemas/EnrollmentResponseDto' },
        child: {
          nullable: true,
          description: 'Present only when toStatus is card_created.',
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Enrollment or group not found.' })
  @ApiConflictResponse({
    description: 'Invalid status transition or enrollment already converted.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Missing required fields for card_created (childName, childDob, currentGroupId, etc.).',
  })
  async transition(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TransitionEnrollmentDto,
  ): Promise<{ enrollment: EnrollmentResponseDto; child?: unknown }> {
    const kgId = requireTenant(t);
    const result = await this.service.transition(
      kgId,
      id,
      {
        toStatus: dto.toStatus,
        comment: dto.comment,
        currentGroupId: dto.currentGroupId,
      },
      user.sub,
    );
    return {
      enrollment: EnrollmentPresenter.toResponseDto(result.enrollment),
      child: result.child ?? undefined,
    };
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign enrollment lead to a staff member.' })
  @ApiOkResponse({ type: EnrollmentResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Enrollment or staff member not found.' })
  @ApiConflictResponse({
    description: 'Enrollment is archived and cannot be reassigned.',
  })
  async assign(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignEnrollmentDto,
  ): Promise<EnrollmentResponseDto> {
    const kgId = requireTenant(t);
    const enrollment = await this.service.assign(kgId, id, {
      assignedTo: dto.assignedTo,
    });
    return EnrollmentPresenter.toResponseDto(enrollment);
  }
}
