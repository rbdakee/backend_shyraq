import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  PARENT_REQUEST_STATUS_VALUES,
  PARENT_REQUEST_TYPE_VALUES,
  type ParentRequestStatusValue,
  type ParentRequestTypeValue,
} from '../infrastructure/persistence/relational/entities/parent-request.typeorm.entity';

export type ListRecipientType = 'admin' | 'mentor' | 'specialist';

const RECIPIENT_TYPES: readonly ListRecipientType[] = [
  'admin',
  'mentor',
  'specialist',
];

export class ListParentRequestsQueryDto {
  @ApiProperty({
    example: 'pending',
    enum: PARENT_REQUEST_STATUS_VALUES,
    required: false,
  })
  @IsOptional()
  @IsEnum(PARENT_REQUEST_STATUS_VALUES)
  status?: ParentRequestStatusValue;

  @ApiProperty({
    example: 'day_off',
    enum: PARENT_REQUEST_TYPE_VALUES,
    required: false,
  })
  @IsOptional()
  @IsEnum(PARENT_REQUEST_TYPE_VALUES)
  type?: ParentRequestTypeValue;

  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  child_id?: string;

  @ApiProperty({
    example: 'gggggggg-1111-2222-3333-gggggggggggg',
    required: false,
    description:
      'Group filter — for staff/admin views; matches `child.current_group_id`.',
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;

  @ApiProperty({
    example: 'mentor',
    enum: RECIPIENT_TYPES,
    required: false,
  })
  @IsOptional()
  @IsEnum(RECIPIENT_TYPES)
  recipient_type?: ListRecipientType;

  @ApiProperty({
    example: 50,
    required: false,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiProperty({
    example: null,
    required: false,
    nullable: true,
    description:
      'Cursor returned by the previous page response (`next_cursor`).',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
