import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description:
      'Opaque refresh token previously issued by /auth/otp/verify or /auth/refresh',
    example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    minLength: 64,
    maxLength: 64,
  })
  @IsString()
  @Length(64, 64)
  refreshToken!: string;
}
