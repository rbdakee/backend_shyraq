import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/**
 * Query of `GET /saas/kindergartens/:id/admins`. Same boolean coercion as
 * `ListKindergartensQueryDto.is_active`. Omitted → both active and
 * deactivated admins are returned.
 */
export class ListKindergartenAdminsQueryDto {
  @ApiPropertyOptional({
    example: true,
    description:
      'Filter admins by active flag. Omit to return ALL admins (active + deactivated).',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  is_active?: boolean;
}
