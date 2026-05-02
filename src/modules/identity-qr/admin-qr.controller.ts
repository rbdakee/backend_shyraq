import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { RevokeAllQrResponseDto } from './dto/revoke-all-qr-response.dto';
import { IdentityQrPresenter } from './identity-qr.presenter';
import { IdentityQrService } from './identity-qr.service';

/**
 * `POST /admin/qr/revoke-all/:userId` — admin bulk-revoke.
 *
 * Stamps `revoked_at` on every active `user_qr_tokens` row for the target
 * user. Cache (Redis) is NOT invalidated — admin only has hashes
 * (plaintext was discarded after issuance), so subsequent scans rely on the
 * service's DB recheck to surface `qr_token_revoked` (410). Cache TTL is
 * ≤24h so stale-hit exposure is bounded.
 *
 * The route lives under `/admin` so it inherits the kindergarten-scoped
 * tenant context; the actual revoke is cross-tenant by row (no
 * `kindergarten_id` filter), which is the correct behavior given QR rows
 * are global to a user.
 */
@ApiTags('Admin / Identity QR')
@ApiBearerAuth()
@Controller({ path: 'admin/qr', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class AdminQrController {
  constructor(private readonly service: IdentityQrService) {}

  @Post('revoke-all/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bulk-revoke every active Identity QR token for the given user. Returns the number of rows just stamped revoked_at.',
  })
  @ApiOkResponse({ type: RevokeAllQrResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not admin.',
  })
  async revokeAll(
    @CurrentUser() admin: JwtPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<RevokeAllQrResponseDto> {
    const { revokedCount } = await this.service.revokeAllByUser(
      admin.sub,
      userId,
    );
    return IdentityQrPresenter.revokeAll(revokedCount);
  }
}
