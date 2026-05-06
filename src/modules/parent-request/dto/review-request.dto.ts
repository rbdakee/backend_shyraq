import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body for staff `accept` / `reject` of a parent_request. The `review_note`
 * is stored on the row and surfaced back to the parent in the response.
 */
export class ReviewRequestDto {
  @ApiProperty({
    example: 'Принято — увидимся в субботу.',
    nullable: true,
    required: false,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  review_note?: string | null;
}
