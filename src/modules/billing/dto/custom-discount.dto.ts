import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type {
  CustomDiscountStatus,
  CustomDiscountTargetType,
  CustomDiscountType,
} from '../domain/entities/custom-discount.entity';
import type { ConditionsRoot } from '../domain/discount-conditions/conditions-evaluator';
import { IsValidConditions } from './validators/is-valid-conditions.decorator';
import { normalizeLegacyKzLocale } from '../../../shared-kernel/utils/i18n-locale-normalizer';

// ── enums ─────────────────────────────────────────────────────────────────

const DISCOUNT_TYPES: CustomDiscountType[] = ['percentage', 'fixed_amount'];

const DISCOUNT_STATUSES: CustomDiscountStatus[] = [
  'draft',
  'active',
  'paused',
  'expired',
  'cancelled',
];

const TARGET_TYPES: CustomDiscountTargetType[] = [
  'all',
  'groups',
  'children',
  'tariff_types',
  'age_range',
];

// ── shared nested DTO ──────────────────────────────────────────────────────

/**
 * Localised text field with required `ru` and `kk` keys.
 * Used for `name`, `description`, `notification_title`, `notification_body`.
 *
 * The index signature `[key: string]: string` makes this compatible with
 * the domain `LocalisedText = Record<string, string>` type without casting.
 *
 * B22b T1: Kazakh is now keyed under BCP-47 `kk` (was the country-code
 * `kz` until B22a). Legacy `kz` rows in the DB are migrated forward by
 * `B22I18nKzToKk` and read-side fallbacks still tolerate `kz` for one
 * release, but new writes go to `kk` only.
 */
export class I18nFieldDto {
  // Index signature required for compatibility with LocalisedText = Record<string, string>.
  [key: string]: string;

  @ApiProperty({
    example: 'Скидка на 8 марта',
    description: 'Russian localisation.',
  })
  @IsString()
  @IsNotEmpty()
  ru!: string;

  @ApiProperty({
    example: '8 наурыз жеңілдігі',
    description: 'Kazakh localisation (BCP 47 `kk`).',
  })
  @IsString()
  @IsNotEmpty()
  kk!: string;
}

// ── request DTOs ───────────────────────────────────────────────────────────

export class CreateCustomDiscountDto {
  @ApiProperty({
    example: { ru: 'Скидка на 8 марта', kk: '8 наурыз жеңілдігі' },
    description:
      'Localised discount name. Both `ru` and `kk` keys are required.',
  })
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  name!: I18nFieldDto;

  @ApiProperty({
    example: {
      ru: 'Скидка действует с 1 по 10 марта',
      kk: 'Жеңілдік 1-10 наурызда қолданылады',
    },
    description: 'Localised description. Optional.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  description?: I18nFieldDto | null;

  @ApiProperty({
    enum: DISCOUNT_TYPES,
    example: 'percentage',
    description:
      '`percentage` — amount is the % off (e.g. 15.00); `fixed_amount` — deducted in KZT.',
  })
  @IsEnum(DISCOUNT_TYPES)
  discount_type!: CustomDiscountType;

  @ApiProperty({
    example: 15.0,
    description:
      'Discount magnitude. For `percentage` this is the percent value (0–100 exclusive). For `fixed_amount` — KZT amount. Must be > 0.',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({
    example: { type: 'date_range', from: '2026-03-01', to: '2026-03-10' },
    description:
      'Conditions JSONB. Empty `{}` means "always apply within targeting + validity window". See domain conditions-evaluator for full schema.',
  })
  @IsValidConditions()
  conditions!: ConditionsRoot;

  @ApiProperty({
    enum: TARGET_TYPES,
    example: 'all',
    description:
      'Targeting mode. `groups`/`children` require `target_ids`. `age_range`/`tariff_types` use `conditions` for the actual range/type filter.',
  })
  @IsEnum(TARGET_TYPES)
  target_type!: CustomDiscountTargetType;

  @ApiProperty({
    example: null,
    description:
      'UUIDs of targeted groups or children. Required for `target_type=groups|children`. Null/omit for `all`, `age_range`, `tariff_types`.',
    required: false,
    nullable: true,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  target_ids?: string[] | null;

  @ApiProperty({
    example: '2026-03-01',
    description: 'ISO date (YYYY-MM-DD). Inclusive start of validity window.',
  })
  @IsDateString()
  valid_from!: string;

  @ApiProperty({
    example: '2026-03-31',
    description:
      'ISO date (YYYY-MM-DD). Inclusive end of validity window. Null means open-ended.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string | null;

  @ApiProperty({
    example: 1,
    description:
      'Maximum times this discount may be applied to a single child. Null means unlimited.',
    required: false,
    nullable: true,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_per_child?: number | null;

  @ApiProperty({
    example: 100,
    description:
      'Global cap on total applications across all children. Null means unlimited.',
    required: false,
    nullable: true,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  total_max_uses?: number | null;

  @ApiProperty({
    example: 100,
    description:
      'Priority for stacking resolution (higher = applied first). Default: 100.',
    required: false,
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiProperty({
    example: false,
    description:
      'Whether this discount stacks with other active discounts. Default: false.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @ApiProperty({
    example: true,
    description:
      'Send push notification to target parents on activation. Default: true.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  notify_on_activation?: boolean;

  @ApiProperty({
    example: { ru: 'Для вашего ребёнка скидка!', kk: 'Балаңызға жеңілдік!' },
    description:
      'Localised push title. **REQUIRED when `notify_on_activation=true` (defaults to true)**. Missing → 422 UnprocessableEntity with `errors.notification_title`. T8 M3 closes the silent no-op where the activation flow used to log+skip when title/body were absent.',
    required: false,
    nullable: true,
  })
  // T8 M3: enforce cross-field invariant `notify_on_activation=true →
  // title required`. The `@ValidateIf` predicate fires the chained
  // validators ONLY when notify is on (default true): in that path the
  // field must be present (`@IsDefined`) and non-null/non-empty
  // (`@IsNotEmpty`). When notify=false, the predicate returns false and
  // class-validator skips subsequent rules entirely → the field stays
  // optional. Returns 400 with `notification_title` in violations.
  @ValidateIf(
    (o: CreateCustomDiscountDto) =>
      o.notify_on_activation === undefined || o.notify_on_activation === true,
  )
  @IsDefined()
  @IsNotEmpty()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  notification_title?: I18nFieldDto | null;

  @ApiProperty({
    example: {
      ru: 'Скидка 15% действует с 1 по 10 марта',
      kk: '15% жеңілдік 1-10 наурыз аралығында',
    },
    description:
      'Localised push body. **REQUIRED when `notify_on_activation=true`** (paired with `notification_title`).',
    required: false,
    nullable: true,
  })
  @ValidateIf(
    (o: CreateCustomDiscountDto) =>
      o.notify_on_activation === undefined || o.notify_on_activation === true,
  )
  @IsDefined()
  @IsNotEmpty()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  notification_body?: I18nFieldDto | null;
}

export class UpdateCustomDiscountDto {
  @ApiProperty({
    example: { ru: 'Скидка на Наурыз', kk: 'Наурыз жеңілдігі' },
    description: 'Updated localised name.',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  name?: I18nFieldDto;

  @ApiProperty({
    example: { ru: 'Акция обновлена', kk: 'Акция жаңартылды' },
    required: false,
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  description?: I18nFieldDto | null;

  @ApiProperty({
    enum: DISCOUNT_TYPES,
    example: 'percentage',
    required: false,
  })
  @IsOptional()
  @IsEnum(DISCOUNT_TYPES)
  discount_type?: CustomDiscountType;

  @ApiProperty({
    example: 20.0,
    description: 'Updated discount magnitude. Must be > 0.',
    required: false,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiProperty({
    example: { type: 'date_range', from: '2026-03-01', to: '2026-03-31' },
    required: false,
  })
  @IsOptional()
  @IsValidConditions()
  conditions?: ConditionsRoot;

  @ApiProperty({
    enum: TARGET_TYPES,
    example: 'all',
    required: false,
  })
  @IsOptional()
  @IsEnum(TARGET_TYPES)
  target_type?: CustomDiscountTargetType;

  @ApiProperty({
    example: null,
    required: false,
    nullable: true,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  target_ids?: string[] | null;

  @ApiProperty({
    example: '2026-03-01',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  valid_from?: string;

  @ApiProperty({
    example: '2026-03-31',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string | null;

  @ApiProperty({ example: 2, required: false, nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_uses_per_child?: number | null;

  @ApiProperty({ example: 200, required: false, nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  total_max_uses?: number | null;

  @ApiProperty({ example: 90, required: false, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  notify_on_activation?: boolean;

  @ApiProperty({
    example: { ru: 'Новое название скидки', kk: 'Жаңа жеңілдік атауы' },
    required: false,
    nullable: true,
    description:
      'Updated localised push title. **REQUIRED when the same PATCH sets `notify_on_activation=true`** (M9 cross-field invariant). Otherwise optional. PATCHing `notify_on_activation=false` clears the requirement; absent `notify_on_activation` keeps the existing persisted title as-is.',
  })
  // B22b T7 M9: cross-field invariant on the PATCH. The Create-DTO already
  // requires title+body whenever `notify_on_activation` is on (default true).
  // For PATCH we only fire the requirement when this very patch explicitly
  // flips `notify_on_activation=true`: at that point the persisted title/body
  // may still be null (e.g. discount created with notify off), so requiring
  // the pair in the same patch keeps the entity invariant intact without
  // touching unrelated rows. Returns 400 with `notification_title` in the
  // validation-error list. When `notify_on_activation` is undefined or
  // explicitly `false`, the chained validators below are skipped → title
  // remains optional (e.g. cosmetic copy update with notify off).
  @ValidateIf((o: UpdateCustomDiscountDto) => o.notify_on_activation === true)
  @IsDefined()
  @IsNotEmpty()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  notification_title?: I18nFieldDto | null;

  @ApiProperty({
    example: {
      ru: 'Обновлённое описание акции',
      kk: 'Жаңартылған акция сипаттамасы',
    },
    required: false,
    nullable: true,
    description:
      'Updated localised push body. **REQUIRED when the same PATCH sets `notify_on_activation=true`** (paired with `notification_title`, M9).',
  })
  @ValidateIf((o: UpdateCustomDiscountDto) => o.notify_on_activation === true)
  @IsDefined()
  @IsNotEmpty()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @ValidateNested()
  @Type(() => I18nFieldDto)
  notification_body?: I18nFieldDto | null;
}

// ── query DTOs ─────────────────────────────────────────────────────────────

export class ListCustomDiscountsQueryDto {
  @ApiProperty({
    enum: DISCOUNT_STATUSES,
    example: 'active',
    description: 'Filter by discount status.',
    required: false,
  })
  @IsOptional()
  @IsEnum(DISCOUNT_STATUSES)
  status?: CustomDiscountStatus;

  @ApiProperty({
    example: '2026-06-30',
    description:
      'Return discounts whose valid_from <= this date (ISO YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  valid_from_to?: string;

  @ApiProperty({
    example: '2026-03-01',
    description:
      'Return discounts whose valid_until >= this date OR valid_until IS NULL (ISO YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  valid_until_from?: string;

  @ApiProperty({
    enum: TARGET_TYPES,
    example: 'all',
    description: 'Filter by targeting mode.',
    required: false,
  })
  @IsOptional()
  @IsEnum(TARGET_TYPES)
  target_type?: CustomDiscountTargetType;

  @ApiProperty({
    example: 1,
    description: 'Page number (1-indexed). Default: 1.',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiProperty({
    example: 20,
    description: 'Page size. Default: 20, max: 100.',
    required: false,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}

export class ListCustomDiscountApplicationsQueryDto {
  @ApiProperty({
    example: 1,
    description: 'Page number (1-indexed). Default: 1.',
    required: false,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiProperty({
    example: 20,
    description: 'Page size. Default: 20, max: 100.',
    required: false,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}

// ── response DTOs ──────────────────────────────────────────────────────────

export class CustomDiscountResponseDto {
  @ApiProperty({ example: 'd1sc0000-0001-0001-0001-000000000001' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({
    example: { ru: 'Скидка на 8 марта', kk: '8 наурыз жеңілдігі' },
    description: 'Localised name.',
  })
  name!: Record<string, string>;

  @ApiProperty({
    example: {
      ru: 'Скидка действует с 1 по 10 марта',
      kk: 'Жеңілдік 1-10 наурызда қолданылады',
    },
    nullable: true,
    description: 'Localised description.',
  })
  description!: Record<string, string> | null;

  @ApiProperty({ enum: DISCOUNT_TYPES, example: 'percentage' })
  discount_type!: CustomDiscountType;

  @ApiProperty({
    example: 15.0,
    description: 'Discount magnitude (% for percentage, KZT for fixed_amount).',
  })
  amount!: number;

  @ApiProperty({
    example: { type: 'date_range', from: '2026-03-01', to: '2026-03-10' },
    description: 'Conditions JSONB. Empty `{}` = always matches.',
  })
  conditions!: ConditionsRoot;

  @ApiProperty({ enum: TARGET_TYPES, example: 'all' })
  target_type!: CustomDiscountTargetType;

  @ApiProperty({
    example: null,
    nullable: true,
    type: [String],
    description:
      'Targeted group/child ids. Null when target_type is `all` or `age_range`.',
  })
  target_ids!: string[] | null;

  @ApiProperty({ example: '2026-03-01', description: 'ISO date YYYY-MM-DD.' })
  valid_from!: string;

  @ApiProperty({
    example: '2026-03-31',
    nullable: true,
    description: 'ISO date YYYY-MM-DD. Null = open-ended.',
  })
  valid_until!: string | null;

  @ApiProperty({ example: 1, nullable: true, description: 'Per-child cap.' })
  max_uses_per_child!: number | null;

  @ApiProperty({ example: 100, nullable: true, description: 'Global cap.' })
  total_max_uses!: number | null;

  @ApiProperty({ example: 0, description: 'Applications logged so far.' })
  used_count!: number;

  @ApiProperty({ example: 100 })
  priority!: number;

  @ApiProperty({ example: false })
  stackable!: boolean;

  @ApiProperty({ example: true })
  notify_on_activation!: boolean;

  @ApiProperty({
    example: { ru: 'Для вашего ребёнка скидка!', kk: 'Балаңызға жеңілдік!' },
    nullable: true,
  })
  notification_title!: Record<string, string> | null;

  @ApiProperty({
    example: {
      ru: 'Скидка 15% действует с 1 по 10 марта',
      kk: '15% жеңілдік 1-10 наурыз аралығында',
    },
    nullable: true,
  })
  notification_body!: Record<string, string> | null;

  @ApiProperty({ enum: DISCOUNT_STATUSES, example: 'draft' })
  status!: CustomDiscountStatus;

  @ApiProperty({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nullable: true,
    description: 'User id of admin who created the discount.',
  })
  created_by!: string | null;

  @ApiProperty({ example: '2026-02-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-02-01T09:00:00.000Z' })
  updated_at!: string;
}

export class CustomDiscountStatsDto {
  @ApiProperty({ example: 42, description: 'Number of applications so far.' })
  count!: number;

  @ApiProperty({
    example: 63000.0,
    description: 'Total KZT amount discounted so far.',
  })
  total_amount_applied!: number;
}

export class CustomDiscountDetailResponseDto {
  @ApiProperty({ type: () => CustomDiscountResponseDto })
  discount!: CustomDiscountResponseDto;

  @ApiProperty({ type: () => CustomDiscountStatsDto })
  stats!: CustomDiscountStatsDto;
}

export class CustomDiscountListResponseDto {
  @ApiProperty({ type: [CustomDiscountResponseDto] })
  rows!: CustomDiscountResponseDto[];

  @ApiProperty({ example: 5, description: 'Total count before pagination.' })
  total!: number;

  @ApiProperty({ example: 1, description: 'Current page (1-indexed).' })
  page!: number;

  @ApiProperty({ example: 20, description: 'Page size.' })
  limit!: number;
}

export class CustomDiscountApplicationResponseDto {
  @ApiProperty({ example: 'a1000000-0001-0001-0001-000000000001' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'd1sc0000-0001-0001-0001-000000000001' })
  custom_discount_id!: string;

  @ApiProperty({ example: 'i1a2b3c4-0005-0005-0005-000000000005' })
  invoice_id!: string;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Specific line item that received the discount, if any.',
  })
  invoice_line_item_id!: string | null;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({
    example: 18000.0,
    description: 'KZT amount actually deducted on this application.',
  })
  amount_applied!: number;

  @ApiProperty({ example: '2026-03-05T07:30:00.000Z' })
  applied_at!: string;
}

export class CustomDiscountApplicationListResponseDto {
  @ApiProperty({ type: [CustomDiscountApplicationResponseDto] })
  rows!: CustomDiscountApplicationResponseDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;
}
