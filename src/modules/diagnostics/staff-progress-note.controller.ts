import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { CreateProgressNoteDto } from './dto/create-progress-note.dto';
import { UpdateProgressNoteDto } from './dto/update-progress-note.dto';
import { ListProgressNotesQueryDto } from './dto/list-progress-notes-query.dto';
import {
  ProgressNoteListResponseDto,
  ProgressNoteResponseDto,
} from './dto/progress-note-response.dto';
import { ProgressNotePresenter } from './progress-note.presenter';
import { ProgressNoteService } from './progress-note.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff CRUD for progress notes (B18).
 *
 * Only `admin` and `mentor` may create / update / delete progress notes
 * (specialist role writes diagnostic entries instead, per BP §8.3).
 * Author-only constraint for updates and deletes is enforced at the service
 * layer; admin callers bypass the author check.
 */
@ApiTags('Staff / Diagnostics — Progress Notes')
@ApiBearerAuth()
@Controller({ path: 'staff/progress-notes', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin', 'mentor')
export class StaffProgressNoteController {
  constructor(
    private readonly service: ProgressNoteService,
    private readonly staffMembers: StaffMemberRepository,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List progress notes. Filters: child_id, mentor_id, from, to. Cursor paginated.',
  })
  @ApiOkResponse({ type: ProgressNoteListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListProgressNotesQueryDto,
  ): Promise<ProgressNoteListResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.listByKgFiltered(kgId, {
      childId: query.child_id,
      mentorId: query.mentor_id,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    return ProgressNotePresenter.list(result.items, result.nextCursor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a progress note for a child.' })
  @ApiCreatedResponse({ type: ProgressNoteResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / empty_body / noted_at_in_future.',
  })
  @ApiNotFoundResponse({ description: 'staff_member_not_found.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateProgressNoteDto,
  ): Promise<ProgressNoteResponseDto> {
    const kgId = requireTenant(t);
    const staffMember = await this.staffMembers.findActiveByUserAndKindergarten(
      user.sub,
      kgId,
    );
    if (!staffMember) {
      throw new NotFoundException('staff_member_not_found');
    }
    const note = await this.service.create(kgId, {
      childId: dto.child_id,
      mentorId: staffMember.id,
      body: dto.body,
      mediaUrls: dto.media_urls ?? [],
      notedAt: dto.noted_at ? new Date(dto.noted_at) : undefined,
    });
    return ProgressNotePresenter.one(note);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update a progress note (body / media_urls). Author-only unless caller is admin.',
  })
  @ApiOkResponse({ type: ProgressNoteResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / empty_body.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Role not allowed / progress_note_not_authored_by_you.',
  })
  @ApiNotFoundResponse({ description: 'progress_note_not_found.' })
  async update(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProgressNoteDto,
  ): Promise<ProgressNoteResponseDto> {
    const kgId = requireTenant(t);
    const staffMember = await this.staffMembers.findActiveByUserAndKindergarten(
      user.sub,
      kgId,
    );
    if (!staffMember) {
      throw new NotFoundException('staff_member_not_found');
    }
    // Admin callers bypass author check by passing the note's actual mentor_id.
    const isAdmin = user.role === 'admin';
    let callerMentorId = staffMember.id;
    if (isAdmin) {
      const existing = await this.service.getById(kgId, id);
      callerMentorId = existing.mentorId;
    }
    const note = await this.service.update(kgId, id, callerMentorId, {
      body: dto.body,
      mediaUrls: dto.media_urls,
    });
    return ProgressNotePresenter.one(note);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a progress note. Author can always delete; admin can delete any.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Role not allowed / progress_note_not_authored_by_you.',
  })
  @ApiNotFoundResponse({ description: 'progress_note_not_found.' })
  async delete(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    const staffMember = await this.staffMembers.findActiveByUserAndKindergarten(
      user.sub,
      kgId,
    );
    if (!staffMember) {
      throw new NotFoundException('staff_member_not_found');
    }
    const isAdmin = user.role === 'admin';
    await this.service.delete(kgId, id, staffMember.id, isAdmin);
  }
}
