import { ApiProperty } from '@nestjs/swagger';
import { ContentPostResponseDto } from './content-post-response.dto';
import { GroupStoryResponseDto } from './group-story-response.dto';

export class ContentFeedResponseDto {
  @ApiProperty({
    type: [ContentPostResponseDto],
    description: 'Published news posts targeted at all / child group / child.',
  })
  news!: ContentPostResponseDto[];

  @ApiProperty({
    type: [ContentPostResponseDto],
    description: 'Published qundylyq (monthly value/theme) posts.',
  })
  qundylyq!: ContentPostResponseDto[];

  @ApiProperty({
    type: [ContentPostResponseDto],
    description: 'Published birthday greetings for this child.',
  })
  birthdays!: ContentPostResponseDto[];

  @ApiProperty({
    type: [GroupStoryResponseDto],
    description: "Active (non-expired) stories from the child's current group.",
  })
  stories!: GroupStoryResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description: "Today's menu — wired in B22 (currently always null).",
  })
  menu_today!: object | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description: "Today's schedule — wired in B22 (currently always null).",
  })
  schedule_today!: object | null;
}
