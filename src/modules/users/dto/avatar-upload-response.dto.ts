import { ApiProperty } from '@nestjs/swagger';

export class AvatarUploadResponseDto {
  @ApiProperty({
    example: '/api/v1/media/avatars/aaaa-uuid/f1e2-uuid.jpg',
    description:
      'Canonical avatar URL. PATCH it into /users/me { avatarUrl }. Presigned on read.',
  })
  avatar_url!: string;
}
