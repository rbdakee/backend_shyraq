import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class LinkLocationDto {
  @ApiProperty({
    example: 'a1b2c3d4-1234-5678-abcd-1234567890ab',
    format: 'uuid',
  })
  @IsUUID()
  location_id!: string;
}
