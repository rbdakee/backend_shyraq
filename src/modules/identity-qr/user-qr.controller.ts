import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { GetMyQrResponseDto } from './dto/get-my-qr-response.dto';
import { IdentityQrPresenter } from './identity-qr.presenter';
import { IdentityQrService } from './identity-qr.service';

/**
 * `GET /users/me/qr` — caller-side QR issuance.
 *
 * Cross-tenant by design: `user_qr_tokens` has no RLS and the QR identifies
 * the user globally. Any authenticated, role-selected user can call this.
 *
 * `@SuperAdminScope()` is set so the global `KindergartenScopeGuard` lets
 * super_admin / support through (they don't have a `kindergarten_id`
 * claim on the JWT and would otherwise be rejected). The decorator also
 * causes the interceptor to use `app.bypass_rls=true` for the wrapping TX,
 * which is irrelevant for this table (no RLS) but harmless.
 *
 * The global `PendingRoleSelectGuard` already rejects pending-role-select
 * JWTs with a 403 — no extra check needed in the handler.
 */
@ApiTags('Users / Identity QR')
@ApiBearerAuth()
@Controller({ path: 'users/me/qr', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
@SuperAdminScope()
export class UserQrController {
  constructor(private readonly service: IdentityQrService) {}

  @Get()
  @ApiOperation({
    summary:
      'Issue or refresh the calling user’s Identity QR. Always mints a fresh token (revokes any previously-active rows in the same TX) and returns plaintext + 24h expiry.',
  })
  @ApiOkResponse({ type: GetMyQrResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'pending_role_select — caller must complete /auth/role first.',
  })
  async getMyQr(@CurrentUser() user: JwtPayload): Promise<GetMyQrResponseDto> {
    const result = await this.service.issueOrRefresh(user.sub);
    return IdentityQrPresenter.myQr(result);
  }
}
