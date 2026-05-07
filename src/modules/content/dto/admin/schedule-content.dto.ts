import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty } from 'class-validator';

export class ScheduleContentDto {
  @ApiProperty({
    example: '2026-05-10T07:00:00.000Z',
    description:
      'Future date-time to schedule this post for publication. Must be strictly in the future (service-side validation).',
  })
  @IsNotEmpty()
  @IsISO8601()
  scheduled_for!: string;
}
