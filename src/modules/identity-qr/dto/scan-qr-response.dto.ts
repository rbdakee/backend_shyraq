import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LinkedChildDto } from './linked-child.dto';

export class ScannedUserDto {
  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  id!: string;

  @ApiProperty({
    example: 'parent',
    description:
      'Effective role used for allowed_actions. parent | mentor | specialist | reception | admin | super_admin.',
  })
  role!: string;

  @ApiProperty({ example: 'Сауле Жанұзақова' })
  fullName!: string;

  @ApiPropertyOptional({
    example: '+77001112233',
    nullable: true,
    description: 'E.164. Returned only to staff users for identification.',
  })
  phone!: string | null;
}

/**
 * Response shape for `POST /staff/qr/scan`.
 *
 * `linkedChildren` is populated only when the scanned user is a parent —
 * the gate-staff app shows the children the parent is approved to pick up
 * so the operator can confirm the right kid is leaving with the right
 * adult. For non-parent roles the field is omitted.
 *
 * `allowedActions` enumerates the gate operations the staff client may
 * trigger after scanning:
 *   - parent (with at least one approved guardian where can_pickup=true)
 *       → ['check_in', 'check_out']
 *   - parent (no can_pickup rights)            → []
 *   - any staff role (mentor/specialist/...)   → ['gate_entry']
 *   - super_admin / support                    → []
 */
export class ScanQrResponseDto {
  @ApiProperty({ type: ScannedUserDto })
  user!: ScannedUserDto;

  @ApiPropertyOptional({
    type: [LinkedChildDto],
    description:
      'Cross-tenant list of children the scanned parent is an approved guardian of. Omitted for non-parent users.',
  })
  linkedChildren?: LinkedChildDto[];

  @ApiProperty({
    example: ['check_in', 'check_out'],
    isArray: true,
    type: String,
    description:
      'Operations the staff client is allowed to perform on this scan. Empty array when the scanned user has no actionable role.',
  })
  allowedActions!: string[];
}
