import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CHILD_INTRADAY_STATUS_VALUES,
  ChildIntradayStatusValue,
} from '../domain/value-objects/child-intraday-status.vo';

export class DailyStatusResponseDto {
  @ApiProperty({ example: 'd1111111-1111-1111-1111-111111111111' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  childId!: string;

  @ApiProperty({ example: '2026-05-01' })
  date!: string;

  @ApiProperty({ enum: CHILD_INTRADAY_STATUS_VALUES, example: 'present' })
  status!: ChildIntradayStatusValue;

  @ApiPropertyOptional({ example: 'Заболел', nullable: true })
  note!: string | null;

  @ApiPropertyOptional({
    example: 'sssssssss-ssss-ssss-ssss-ssssssssssss',
    nullable: true,
  })
  setBy!: string | null;

  @ApiPropertyOptional({
    example: 'Айгуль Сатпаева',
    nullable: true,
    description:
      'Display name of the staff member who set the status (identity ' +
      'overlay: staff_members.id → users.full_name via the staff identity ' +
      'fallback). null when setBy is absent or the name is empty/whitespace.',
  })
  set_by_full_name!: string | null;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  updatedAt!: string;
}
