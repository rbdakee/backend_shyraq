import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class ListSpecialistTypesQueryDto {
  @ApiPropertyOptional({
    description:
      'Include deactivated rows. Default false (active only) — the staff/diagnostics dropdown only wants active ones.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value as unknown;
  })
  @IsBoolean()
  include_inactive?: boolean;
}
