import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { SkipMediaSign } from '@/common/decorators/skip-media-sign.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { AvatarUploadResponseDto } from './dto/avatar-upload-response.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UsersPresenter } from './users.presenter';
import { UsersService } from './users.service';

const ALLOWED_AVATAR_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

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

  @Post('me/avatar')
  @HttpCode(HttpStatus.OK)
  // Returns the CANONICAL `/api/v1/media/avatars/<userId>/<uuid>.<ext>` URL so
  // the client can PATCH it into /users/me { avatarUrl }. Must NOT be presigned
  // — a signed (expiring) URL persisted in users.avatar_url breaks after TTL.
  @SkipMediaSign()
  @ApiOperation({
    summary:
      'Upload current user avatar (image ≤5MB). Returns canonical avatar_url to PATCH into /users/me.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Single image. Field name `file`. jpg/png/webp, ≤5MB.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOkResponse({ type: AvatarUploadResponseDto })
  @ApiBadRequestResponse({
    description:
      'avatar_file_required / avatar_type_invalid / avatar_too_large',
  })
  @ApiUnauthorizedResponse()
  @UseInterceptors(
    FilesInterceptor('file', 1, { limits: { fileSize: MAX_AVATAR_BYTES } }),
  )
  async uploadAvatar(
    @CurrentUser() user: JwtPayload,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<AvatarUploadResponseDto> {
    const file = files?.[0];
    if (!file) {
      throw new BadRequestException('avatar_file_required');
    }
    if (
      !ALLOWED_AVATAR_MIMETYPES.includes((file.mimetype ?? '').toLowerCase())
    ) {
      throw new BadRequestException('avatar_type_invalid');
    }
    // multer's `fileSize` limit already caps the upload; this is defence-in-depth.
    if (file.size > MAX_AVATAR_BYTES) {
      throw new BadRequestException('avatar_too_large');
    }
    const { avatarUrl } = await this.users.uploadAvatar(user.sub, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
    const dto = new AvatarUploadResponseDto();
    dto.avatar_url = avatarUrl;
    return dto;
  }
}
