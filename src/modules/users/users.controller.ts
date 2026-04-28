import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersPresenter } from './users.presenter';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller({ path: 'users', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get the current user’s profile',
    description:
      'Resolved from the JWT `sub` claim. Returns the shared identity record (phone, full name, avatar, iin, locale). Roles + kindergartens are returned by /auth endpoints, not here.',
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse({
    description:
      'pending_role_select — finish /auth/role/select before reading /users/me',
  })
  @ApiNotFoundResponse()
  async getMe(@CurrentUser() user: JwtPayload): Promise<UserResponseDto> {
    return UsersPresenter.user(await this.users.getMe(user.sub));
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Patch the current user’s profile',
    description:
      'Updates only fields present in the body (PATCH semantics). IIN must be globally unique — duplicates yield 409 Conflict (`iin_already_taken`).',
  })
  @ApiBody({
    type: UpdateMeDto,
    examples: {
      rename: { value: { fullName: 'Aisha Bekova-Updated' } },
      switchLocale: { value: { locale: 'kk' } },
      bindIin: { value: { iin: '901231400123', dateOfBirth: '1990-12-31' } },
    },
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'DTO validation failed' })
  @ApiUnauthorizedResponse()
  @ApiConflictResponse({ description: 'iin_already_taken / unique_violation' })
  async updateMe(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateMeDto,
  ): Promise<UserResponseDto> {
    const updated = await this.users.updateMe(user.sub, {
      fullName: dto.fullName,
      avatarUrl: dto.avatarUrl,
      iin: dto.iin,
      dateOfBirth:
        dto.dateOfBirth === undefined
          ? undefined
          : dto.dateOfBirth === null
            ? null
            : new Date(dto.dateOfBirth),
      locale: dto.locale,
    });
    return UsersPresenter.user(updated);
  }
}
