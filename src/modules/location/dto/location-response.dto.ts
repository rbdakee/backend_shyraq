import { ApiProperty } from '@nestjs/swagger';

export class LocationDto {
  @ApiProperty({ example: 'a1b2c3d4-1234-5678-abcd-1234567890ab' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'Main Hall' })
  name!: string;

  @ApiProperty({ example: null, nullable: true })
  description!: string | null;

  @ApiProperty({ example: null, nullable: true })
  archived_at!: string | null;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  updated_at!: string;
}
