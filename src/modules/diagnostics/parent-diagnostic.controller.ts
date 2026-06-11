import {
  BadRequestException,
  Controller,
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
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ParentListDiagnosticEntriesQueryDto } from './dto/parent-list-diagnostic-entries-query.dto';
import { ParentListProgressNotesQueryDto } from './dto/parent-list-progress-notes-query.dto';
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

/**
 * Build a template lookup map for a batch of entries with ONE batch
 * SELECT (B22b T5 / B18 M6 closure). Identical contract to the staff
 * controller helper — kept inline rather than shared because the two
 * controllers live in the same module and the function is 10 lines.
 */
async function buildTemplateLookup(
  kgId: string,
  entries: DiagnosticEntry[],
  templateService: DiagnosticTemplateService,
): Promise<Map<string, TemplateLookup>> {
  const uniqueTemplateIds = [...new Set(entries.map((e) => e.templateId))];
  const lookup = new Map<string, TemplateLookup>();
  if (uniqueTemplateIds.length === 0) {
    return lookup;
  }
  const templates = await templateService.listByIds(kgId, uniqueTemplateIds);
  for (const tid of uniqueTemplateIds) {
    const tpl = templates.get(tid);
    lookup.set(
      tid,
      tpl ? { name: tpl.name, version: tpl.version } : { name: '', version: 0 },
    );
  }
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
 * non-revoked guardian of `:childId`. The service additionally evaluates
 * `permissions.view_diagnostics` via `assertParentCanViewDiagnostics`.
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
    @Query() query: ParentListDiagnosticEntriesQueryDto,
  ): Promise<DiagnosticEntryListResponseDto> {
    const kgId = requireTenant(t);
    await this.entryService.assertParentCanViewDiagnostics(
      kgId,
      user.sub,
      childId,
    );
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
    const specialistNames = await this.entryService.resolveSpecialistNames(
      kgId,
      result.items,
    );
    return DiagnosticEntryPresenter.list(
      result.items,
      result.nextCursor,
      lookup,
      specialistNames,
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
    await this.entryService.assertParentCanViewDiagnostics(
      kgId,
      user.sub,
      childId,
    );
    // FINDINGS M1 (B22a T8) — `getByIdForChild` enforces
    // `entry.childId === childId`. Without this binding the URL
    // `:childId` was authoritative for the permission check while
    // `entryId` was loaded in isolation, so a guardian of child A
    // could request `/parent/children/{A}/diagnostics/{entryOfB}`
    // and receive child B's entry. Mismatch → 404.
    const entry = await this.entryService.getByIdForChild(
      kgId,
      childId,
      entryId,
    );
    const template = await this.templateService.getById(kgId, entry.templateId);
    const lookup = new Map<string, TemplateLookup>([
      [entry.templateId, { name: template.name, version: template.version }],
    ]);
    const specialistNames = await this.entryService.resolveSpecialistNames(
      kgId,
      [entry],
    );
    return DiagnosticEntryPresenter.one(
      entry,
      lookup,
      specialistNames.get(entry.specialistId) ?? null,
    );
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
    @Query() query: ParentListProgressNotesQueryDto,
  ): Promise<ProgressNoteListResponseDto> {
    const kgId = requireTenant(t);
    await this.entryService.assertParentCanViewDiagnostics(
      kgId,
      user.sub,
      childId,
    );
    const result = await this.progressNoteService.listByChild(kgId, childId, {
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    const mentorNames = await this.progressNoteService.resolveMentorNames(
      kgId,
      result.items,
    );
    return ProgressNotePresenter.list(
      result.items,
      result.nextCursor,
      mentorNames,
    );
  }
}
