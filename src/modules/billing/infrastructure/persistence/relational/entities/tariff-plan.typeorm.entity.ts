import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from '@/shared-kernel/infrastructure/typeorm/money-kzt.transformer';
import { DiscountRules } from '../../../../domain/entities/tariff-plan.entity';

export const TARIFF_TYPE_VALUES = [
  'monthly',
  'additional_service',
  'late_pickup_fee',
  'prepayment_3m',
  'prepayment_6m',
  'prepayment_12m',
  'prepayment_24m',
  'other',
] as const;

export type TariffTypeValue = (typeof TARIFF_TYPE_VALUES)[number];

export const TARIFF_APPLIES_TO_VALUES = [
  'all_children',
  'group',
  'age_range',
  'individual',
] as const;

export type TariffAppliesToValue = (typeof TARIFF_APPLIES_TO_VALUES)[number];

@Entity({ name: 'tariff_plans' })
export class TariffPlanTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'description', type: 'jsonb', default: '{}' })
  description!: Record<string, string>;

  @Column({
    name: 'tariff_type',
    type: 'enum',
    enum: TARIFF_TYPE_VALUES,
    enumName: 'tariff_type',
  })
  tariffType!: TariffTypeValue;

  @Column({
    name: 'amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: moneyKztTransformer,
  })
  amount!: MoneyKzt;

  @Column({ name: 'currency', type: 'char', length: 3, default: 'KZT' })
  currency!: string;

  @Column({
    name: 'applies_to',
    type: 'enum',
    enum: TARIFF_APPLIES_TO_VALUES,
    enumName: 'tariff_applies_to',
  })
  appliesTo!: TariffAppliesToValue;

  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  groupId!: string | null;

  @Column({ name: 'age_min_months', type: 'smallint', nullable: true })
  ageMinMonths!: number | null;

  @Column({ name: 'age_max_months', type: 'smallint', nullable: true })
  ageMaxMonths!: number | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'valid_from', type: 'date' })
  validFrom!: Date | string;

  @Column({ name: 'valid_until', type: 'date', nullable: true })
  validUntil!: Date | string | null;

  @Column({ name: 'discount_rules', type: 'jsonb', default: '{}' })
  discountRules!: DiscountRules;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
