import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignEnrollmentDto {
  @ApiProperty({ example: 'b2a1c0d9-0000-0000-0000-000000000001' })
  @IsUUID()
  assignedTo!: string;
}
