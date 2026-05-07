import { ApiProperty } from '@nestjs/swagger';
import { ContentPostResponseDto } from './content-post-response.dto';

export class ContentListResponseDto {
  @ApiProperty({ type: [ContentPostResponseDto] })
  items!: ContentPostResponseDto[];

  @ApiProperty({
    example: 'eyJpZCI6ImFiYyJ9',
    nullable: true,
    description: 'Cursor for the next page, or null if no more pages.',
  })
  cursor!: string | null;
}
