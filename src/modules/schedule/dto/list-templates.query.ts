import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class ListSchedulesTemplatesQuery {
  @ApiPropertyOptional({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined
      ? undefined
      : value === 'true' || value === true
        ? true
        : value === 'false' || value === false
          ? false
          : value,
  )
  @IsBoolean()
  isActive?: boolean;
}
