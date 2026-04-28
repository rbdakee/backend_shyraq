import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignMentorDto {
  @ApiProperty({
    example: 'stf-1234-5678-abcd-1234567890ab',
    description:
      'UUID of the staff_member (must belong to the tenant and be active).',
    format: 'uuid',
  })
  @IsUUID()
  staff_member_id!: string;
}
