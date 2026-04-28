import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class SuperAdminLoginDto {
  @ApiProperty({
    description: 'SaaS-operator email — uniquely identifies the saas_users row',
    example: 'admin@shyraq.local',
    format: 'email',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: 'Plaintext password — verified against stored bcrypt hash',
    example: 'admin123',
    minLength: 8,
  })
  @IsString()
  @MinLength(8)
  password!: string;
}
