import { ApiProperty } from '@nestjs/swagger';

class ChildNeedingDiagnosticDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'Айгерим Сейткали' })
  child_name!: string;

  @ApiProperty({
    example: '2025-10-15',
    nullable: true,
    description:
      'ISO date YYYY-MM-DD of the most recent diagnostic, or null if never assessed.',
  })
  last_assessment_date!: string | null;

  @ApiProperty({
    example: 203,
    nullable: true,
    description:
      'Whole days elapsed since the last assessment in Asia/Almaty timezone, or null if never assessed.',
  })
  days_since_last!: number | null;
}

export class MyTodosResponseDto {
  @ApiProperty({
    type: [ChildNeedingDiagnosticDto],
    description:
      'Children whose latest diagnostic is older than 6 months or who have never been assessed. Sorted: never-assessed first, then most-stale first.',
  })
  children_needing_diagnostic!: ChildNeedingDiagnosticDto[];
}
