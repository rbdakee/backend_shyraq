import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class MyTodosQueryDto {
  @ApiProperty({
    example: 'speech_therapist',
    description:
      'Admin-only override: filter my-todos for a specific specialist_type. Ignored for non-admin callers (their own specialist_type is always used).',
    required: false,
  })
  @IsOptional()
  @IsString()
  specialist_type?: string;
}
