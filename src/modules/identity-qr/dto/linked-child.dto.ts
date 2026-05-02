import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Compact child snapshot returned inside `ScanQrResponseDto.linkedChildren`
 * when the scanned user is a parent. Cross-tenant by design: the staff doing
 * the scan may be in a different kindergarten than where the child is
 * enrolled (the QR is global to a user, not scoped to a tenant).
 */
export class LinkedChildDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  id!: string;

  @ApiProperty({ example: 'Айдар Жанұзақов' })
  fullName!: string;

  @ApiPropertyOptional({
    example: 'gggggggg-gggg-gggg-gggg-gggggggggggg',
    nullable: true,
    description: 'Currently assigned group id, or null when unassigned.',
  })
  currentGroupId!: string | null;

  @ApiPropertyOptional({
    example: 'https://cdn.shyraq.kz/children/cccc.jpg',
    nullable: true,
  })
  photoUrl!: string | null;
}
