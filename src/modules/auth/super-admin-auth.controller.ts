import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { AuthPresenter } from './auth.presenter';
import { AuthService } from './auth.service';
import { SuperAdminAuthResponseDto } from './dto/auth-response.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { SuperAdminLoginDto } from './dto/super-admin-login.dto';

@ApiTags('SuperAdmin')
@Controller({ path: 'saas/auth', version: '1' })
export class SuperAdminAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SaaS-operator login (email + password)',
    description:
      'Verifies credentials against the saas_users table (bcrypt). On success returns Bearer access + refresh tokens valid only for the /saas/* surface. SuperAdmin sessions bypass tenant RLS via the `app.bypass_rls` GUC.',
  })
  @ApiBody({
    type: SuperAdminLoginDto,
    examples: {
      default: {
        value: { email: 'admin@shyraq.local', password: 'admin123' },
      },
    },
  })
  @ApiOkResponse({ type: SuperAdminAuthResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed on body' })
  @ApiUnauthorizedResponse({
    description: 'invalid_credentials — bad email/password or inactive user',
  })
  async login(
    @Body() dto: SuperAdminLoginDto,
    @Req() req: Request,
  ): Promise<SuperAdminAuthResponseDto> {
    const result = await this.auth.superAdminLogin({
      email: dto.email,
      password: dto.password,
      ipAddress: req.ip,
    });
    return AuthPresenter.superAdminAuthResult(result);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate a SuperAdmin refresh token',
    description:
      'Same flow as the tenant /auth/refresh, scoped to the saas_refresh_tokens table — separate by design (D1 no-polymorphism).',
  })
  @ApiBody({
    type: RefreshTokenDto,
    examples: {
      default: {
        value: {
          refreshToken:
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      },
    },
  })
  @ApiOkResponse({ type: SuperAdminAuthResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token unknown, expired, or already revoked',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<SuperAdminAuthResponseDto> {
    const result = await this.auth.superAdminRefresh({
      rawRefreshToken: dto.refreshToken,
      ipAddress: req.ip,
    });
    return AuthPresenter.superAdminAuthResult(result);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @SuperAdminScope()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a SuperAdmin refresh + blocklist the JTI' })
  @ApiBody({
    type: RefreshTokenDto,
    required: false,
    examples: {
      withRefresh: {
        value: {
          refreshToken:
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      },
    },
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse()
  async logout(
    @CurrentUser() user: JwtPayload,
    @Body() body: Partial<RefreshTokenDto>,
  ): Promise<void> {
    await this.auth.superAdminLogout({
      saasUserId: user.sub,
      rawRefreshToken: body?.refreshToken,
      accessJti: user.jti,
      accessExpUnix: user.exp,
    });
  }
}
