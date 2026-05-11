import { ApiProperty } from '@nestjs/swagger';

export class UploadMediaResponseDto {
  @ApiProperty({
    example:
      '/api/v1/media/a0b1c2d3-0000-0000-0000-000000000099/2026-05/f1e2d3c4-uuid.jpg',
    description: 'Publicly accessible URL for the uploaded file.',
  })
  url!: string;

  @ApiProperty({
    example: 'a0b1c2d3-0000-0000-0000-000000000099/2026-05/f1e2d3c4-uuid.jpg',
    description: 'Storage key (pass to FileStoragePort.delete).',
  })
  key!: string;

  @ApiProperty({
    example: 204800,
    description: 'File size in bytes.',
  })
  bytes!: number;
}
