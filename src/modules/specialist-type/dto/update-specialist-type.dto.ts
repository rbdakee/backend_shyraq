import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional } from 'class-validator';

/**
 * Partial patch. `code` is NOT patchable — renaming a code would orphan every
 * staff/diagnostics row that references it.
 */
export class UpdateSpecialistTypeDto {
  @ApiPropertyOptional({
    example: { ru: 'Нейропсихолог (Психолог)', kk: 'Нейропсихолог' },
    description:
      'Localised labels object. At least one of `ru` / `kk` must be non-empty.',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  name_i18n?: Record<string, string>;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  sort_order?: number;
}
