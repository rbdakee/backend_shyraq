import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
} from 'class-validator';
import type {
  TariffAppliesTo,
  TariffType,
  DiscountRules,
} from '../domain/entities/tariff-plan.entity';

const TARIFF_TYPES: TariffType[] = [
  'monthly',
  'additional_service',
  'late_pickup_fee',
  'prepayment_3m',
  'prepayment_6m',
  'prepayment_12m',
  'prepayment_24m',
  'other',
];

const APPLIES_TO_VALUES: TariffAppliesTo[] = [
  'all_children',
  'group',
  'age_range',
  'individual',
];

export class CreateTariffPlanDto {
  @ApiProperty({
    example: 'Стандартный ежемесячный тариф',
    description: 'Human-readable name of the tariff plan.',
    minLength: 1,
  })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({
    example: { ru: 'Стандартный тариф', kz: 'Стандартты тариф' },
    description: 'Locale map for description. At least one key expected.',
    required: false,
  })
  @IsOptional()
  @IsObject()
  description?: Record<string, string>;

  @ApiProperty({
    enum: TARIFF_TYPES,
    example: 'monthly',
    description:
      'Determines how the plan is applied during invoice generation.',
  })
  @IsEnum(TARIFF_TYPES)
  tariff_type!: TariffType;

  @ApiProperty({
    example: 120000,
    description: 'Base amount in KZT (tenge). Must be >= 0.',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({
    enum: APPLIES_TO_VALUES,
    example: 'all_children',
    description:
      'Scoping rule: all_children, group (requires group_id), age_range (requires age bounds), individual.',
  })
  @IsEnum(APPLIES_TO_VALUES)
  applies_to!: TariffAppliesTo;

  @ApiProperty({
    example: 'a1b2c3d4-1111-2222-3333-aabbccddeeff',
    description: 'Required when applies_to=group.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  group_id?: string | null;

  @ApiProperty({
    example: 36,
    description:
      'Inclusive lower age bound in months. Required when applies_to=age_range.',
    required: false,
    nullable: true,
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  age_min_months?: number | null;

  @ApiProperty({
    example: 72,
    description:
      'Inclusive upper age bound in months. Required when applies_to=age_range.',
    required: false,
    nullable: true,
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  age_max_months?: number | null;

  @ApiProperty({
    example: '2026-06-01',
    description: 'ISO date (YYYY-MM-DD) from which the plan is valid.',
  })
  @IsDateString()
  valid_from!: string;

  @ApiProperty({
    example: '2027-05-31',
    description: 'ISO date (YYYY-MM-DD). Null means open-ended.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string | null;

  @ApiProperty({
    example: {
      sibling_discount_pct: 15,
      prepay_3m_pct: 5,
      prepay_6m_pct: 7,
      prepay_12m_pct: 10,
      prepay_24m_pct: 12,
    },
    description:
      'Optional discount rules persisted as jsonb. Keys: sibling_discount_pct, prepay_3m_pct, prepay_6m_pct, prepay_12m_pct, prepay_24m_pct, benefit_category.',
    required: false,
  })
  @IsOptional()
  @IsObject()
  discount_rules?: DiscountRules;
}

export class UpdateTariffPlanDto {
  @ApiProperty({
    example: 'Обновлённый тариф',
    description: 'New name for the tariff plan.',
    required: false,
    minLength: 1,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiProperty({
    example: { ru: 'Обновлённый тариф', kz: 'Жаңартылған тариф' },
    required: false,
  })
  @IsOptional()
  @IsObject()
  description?: Record<string, string>;

  @ApiProperty({
    example: 130000,
    description: 'Updated amount in KZT.',
    required: false,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiProperty({
    example: {
      sibling_discount_pct: 20,
      prepay_12m_pct: 12,
    },
    required: false,
  })
  @IsOptional()
  @IsObject()
  discount_rules?: DiscountRules;

  @ApiProperty({
    example: '2027-12-31',
    description: 'ISO date (YYYY-MM-DD). Set to today to close the plan.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string | null;
}

export class TariffPlanResponseDto {
  @ApiProperty({ example: 'f1a2b3c4-0001-0001-0001-000000000001' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'Стандартный ежемесячный тариф' })
  name!: string;

  @ApiProperty({
    example: { ru: 'Стандартный тариф', kz: 'Стандартты тариф' },
    description: 'Locale map for description.',
  })
  description!: Record<string, string>;

  @ApiProperty({ enum: TARIFF_TYPES, example: 'monthly' })
  tariff_type!: TariffType;

  @ApiProperty({ example: 120000, description: 'Amount in KZT.' })
  amount!: number;

  @ApiProperty({ example: 'KZT' })
  currency!: string;

  @ApiProperty({ enum: APPLIES_TO_VALUES, example: 'all_children' })
  applies_to!: TariffAppliesTo;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Group id when applies_to=group.',
  })
  group_id!: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Lower age bound in months.',
  })
  age_min_months!: number | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Upper age bound in months.',
  })
  age_max_months!: number | null;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: '2026-06-01' })
  valid_from!: string;

  @ApiProperty({ example: '2027-05-31', nullable: true })
  valid_until!: string | null;

  @ApiProperty({
    example: { sibling_discount_pct: 15, prepay_12m_pct: 10 },
    description: 'Discount rules jsonb.',
  })
  discount_rules!: DiscountRules;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  updated_at!: string;
}

export class ListTariffPlansQueryDto {
  @ApiProperty({
    example: true,
    description: 'Filter by active/inactive status.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  is_active?: boolean;

  @ApiProperty({
    enum: TARIFF_TYPES,
    example: 'monthly',
    description: 'Filter by tariff type.',
    required: false,
  })
  @IsOptional()
  @IsEnum(TARIFF_TYPES)
  tariff_type?: TariffType;

  @ApiProperty({
    example: 'a1b2c3d4-1111-2222-3333-aabbccddeeff',
    description: 'Filter plans scoped to a specific group.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;
}
