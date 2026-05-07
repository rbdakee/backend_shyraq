import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { NannyNoDiagnosticsAccessError } from './domain/errors/nanny-no-diagnostics-access.error';
import { ListDiagnosticEntriesQueryDto } from './dto/list-diagnostic-entries-query.dto';
import { ListProgressNotesQueryDto } from './dto/list-progress-notes-query.dto';
import {
  DiagnosticEntryListResponseDto,
  DiagnosticEntryResponseDto,
} from './dto/diagnostic-entry-response.dto';
import { ProgressNoteListResponseDto } from './dto/progress-note-response.dto';
import {
  DiagnosticEntryPresenter,
  TemplateLookup,
} from './diagnostic-entry.presenter';
import { ProgressNotePresenter } from './progress-note.presenter';
import { DiagnosticEntryService } from './diagnostic-entry.service';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import { ProgressNoteService } from './progress-note.service';
import { DiagnosticEntry } from './domain/entities/diagnostic-entry.entity';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/** Build a template lookup map for a batch of entries. */
async function buildTemplateLookup(
  kgId: string,
  entries: DiagnosticEntry[],
  templateService: DiagnosticTemplateService,
): Promise<Map<string, TemplateLookup>> {
  const uniqueTemplateIds = [...new Set(entries.map((e) => e.templateId))];
  const lookup = new Map<string, TemplateLookup>();
  await Promise.all(
    uniqueTemplateIds.map(async (tid) => {
      try {
        const tpl = await templateService.getById(kgId, tid);
        lookup.set(tid, { name: tpl.name, version: tpl.version });
      } catch {
        lookup.set(tid, { name: '', version: 0 });
      }
    }),
  );
  return lookup;
}

/**
 * Parent read-only access to a child's diagnostic entries and progress notes
 * (B18).
 *
 * Permission gate (BP §8.5):
 *   - Primary / secondary guardians have `view_diagnostics = true` by default
 *     and may access both diagnostic entries and progress notes.
 *   - Nanny guardians have `view_diagnostics = false` by default → 403
 *     `nanny_no_diagnostics_access`.
 *
 * `ChildAccessGuard` (mounted globally at the route level via the controller
 * class guard chain) already validates that the caller is an APPROVED,
 * non-revoked guardian of `:childId`. We then additionally evaluate
 * `permissions.view_diagnostics` here.
 */
@ApiTags('Parent / Diagnostics')
@ApiBearerAuth()
@Controller({ path: 'parent/children/:childId', version: '1' })
@UseGuards(ChildAccessGuard, RolesGuard)
@Roles('parent')
export class ParentDiagnosticController {
  constructor(
    private readonly entryService: DiagnosticEntryService,
    private readonly templateService: DiagnosticTemplateService,
    private readonly progressNoteService: ProgressNoteService,
    private readonly guardians: ChildGuardianRepository,
  ) {}

  // ── Diagnostic entries ────────────────────────────────────────────────────

  @Get('diagnostics')
  @ApiOperation({
    summary:
      "List diagnostic entries for the child. Requires guardian's view_diagnostics permission. Nanny → 403.",
  })
  @ApiOkResponse({ type: DiagnosticEntryListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'child_access_denied (not an approved guardian) / nanny_no_diagnostics_access.',
  })
  async listDiagnostics(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() query: ListDiagnosticEntriesQueryDto,
  ): Promise<DiagnosticEntryListResponseDto> {
    const kgId = requireTenant(t);
    await this.assertViewDiagnosticsPermission(kgId, user.sub, childId);
    const result = await this.entryService.listByChild(kgId, childId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    const lookup = await buildTemplateLookup(
      kgId,
      result.items,
      this.templateService,
    );
    return DiagnosticEntryPresenter.list(
      result.items,
      result.nextCursor,
      lookup,
    );
  }

  @Get('diagnostics/:entryId')
  @ApiOperation({
    summary:
      'Get a single diagnostic entry for the child. Requires view_diagnostics. Nanny → 403.',
  })
  @ApiOkResponse({ type: DiagnosticEntryResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'child_access_denied / nanny_no_diagnostics_access.',
  })
  @ApiNotFoundResponse({ description: 'diagnostic_entry_not_found.' })
  async getDiagnostic(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
  ): Promise<DiagnosticEntryResponseDto> {
    const kgId = requireTenant(t);
    await this.assertViewDiagnosticsPermission(kgId, user.sub, childId);
    const entry = await this.entryService.getById(kgId, entryId);
    const template = await this.templateService.getById(kgId, entry.templateId);
    const lookup = new Map<string, TemplateLookup>([
      [entry.templateId, { name: template.name, version: template.version }],
    ]);
    return DiagnosticEntryPresenter.one(entry, lookup);
  }

  // ── Progress notes ────────────────────────────────────────────────────────

  @Get('progress-notes')
  @ApiOperation({
    summary:
      "List progress notes for the child. Requires guardian's view_diagnostics permission. Nanny → 403.",
  })
  @ApiOkResponse({ type: ProgressNoteListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'child_access_denied / nanny_no_diagnostics_access.',
  })
  async listProgressNotes(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() query: ListProgressNotesQueryDto,
  ): Promise<ProgressNoteListResponseDto> {
    const kgId = requireTenant(t);
    await this.assertViewDiagnosticsPermission(kgId, user.sub, childId);
    const result = await this.progressNoteService.listByChild(kgId, childId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    return ProgressNotePresenter.list(result.items, result.nextCursor);
  }

  // ── Permission helper ──────────────────────────────────────────────────────

  /**
   * Checks that the requesting user is an approved, non-revoked guardian of
   * `childId` with `view_diagnostics = true`. Throws 403 when either the
   * guardian row is missing (ChildAccessGuard should have caught this already
   * but we re-validate for the permission flag) or the effective permission is
   * false (nanny case).
   */
  private async assertViewDiagnosticsPermission(
    kgId: string,
    userId: string,
    childId: string,
  ): Promise<void> {
    const guardian = await this.guardians.findApprovedActiveByUserAndChild(
      kgId,
      childId,
      userId,
    );
    if (!guardian) {
      throw new ForbiddenException('not_a_guardian');
    }
    const effective = guardian.permissions.effective(guardian.role);
    if (!effective.view_diagnostics) {
      throw new NannyNoDiagnosticsAccessError();
    }
  }
}
