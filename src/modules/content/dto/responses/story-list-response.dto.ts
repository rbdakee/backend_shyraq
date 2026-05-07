import { ApiProperty } from '@nestjs/swagger';
import { GroupStoryResponseDto } from './group-story-response.dto';

export class StoryListResponseDto {
  @ApiProperty({ type: [GroupStoryResponseDto] })
  items!: GroupStoryResponseDto[];
}
