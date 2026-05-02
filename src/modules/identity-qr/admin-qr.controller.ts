import {
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
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
 * user, then clears `qr:user:{userId}:identity` Redis (so the next user
 * GET mints fresh). Plaintext-keyed Redis (`qr:token:{plaintext}`) is NOT
 * invalidated — admin only has hashes — so subsequent scans rely on the
 * service's DB recheck to surface `qr_token_revoked` (410). Cache TTL is
 * ≤24h so stale-hit exposure is bounded.
 *
 * Tenant scoping: the QR rows themselves are cross-tenant (one QR per user
 * across kindergartens), but the admin authorization is kg-scoped — the
 * service rejects with 403 `user_no_relationship_to_kindergarten` unless
 * the target user is an active staff_member in caller's kg or an approved
 * (non-revoked) child_guardian for a child in caller's kg. Unknown userId
 * → 404 `user_not_found`. The route inherits caller's kg from the JWT
 * via `KindergartenScopeGuard`.
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
    description:
      'Caller is not admin OR target user has no active staff_member / approved guardian relationship with caller’s kindergarten (`user_no_relationship_to_kindergarten`).',
  })
  @ApiNotFoundResponse({
    description: 'Target userId does not exist (`user_not_found`).',
  })
  async revokeAll(
    @CurrentUser() admin: JwtPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<RevokeAllQrResponseDto> {
    // RolesGuard@admin guarantees the caller is an admin in some kg, so
    // `kindergarten_id` is a non-null UUID on the JWT. Defensive guard
    // anyway because a misconfigured guard chain would otherwise let the
    // service receive `undefined` and crash.
    if (!admin.kindergarten_id) {
      throw new InternalServerErrorException(
        'admin caller missing kindergarten_id claim',
      );
    }
    const { revokedCount } = await this.service.revokeAllByUser(
      admin.sub,
      userId,
      admin.kindergarten_id,
    );
    return IdentityQrPresenter.revokeAll(revokedCount);
  }
}
