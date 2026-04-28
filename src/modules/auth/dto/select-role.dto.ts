import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class SelectRoleDto {
  @ApiProperty({
    description: 'Kindergarten the role applies to',
    example: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
    format: 'uuid',
  })
  @IsUUID('4')
  kindergartenId!: string;

  @ApiProperty({
    description:
      'Role name to assume. Optional when the user has exactly one role in the chosen kindergarten.',
    example: 'teacher',
    required: false,
  })
  @IsOptional()
  @IsString()
  role?: string;
}
