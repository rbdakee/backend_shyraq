import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class TransferChildGroupDto {
  @ApiProperty({
    example: 'c3d4e5f6-2345-6789-bcde-2345678901bc',
    format: 'uuid',
  })
  @IsUUID()
  to_group_id!: string;

  @ApiPropertyOptional({ example: 'Promoted to senior group.' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AssignGroupDto {
  @ApiProperty({
    example: 'b2c3d4e5-1234-5678-abcd-1234567890ab',
    format: 'uuid',
  })
  @IsUUID()
  group_id!: string;
}
