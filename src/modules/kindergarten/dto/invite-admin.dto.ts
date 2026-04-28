import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class InviteAdminDto {
  @ApiProperty({
    example: '+77011112233',
    description: 'Admin phone — E.164 format. SMS is best-effort.',
  })
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'invalid_phone_format' })
  phone!: string;
}
