import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from '@/shared-kernel/infrastructure/typeorm/money-kzt.transformer';

export const CUSTOM_DISCOUNT_STATUS_VALUES = [
  'draft',
  'active',
  'paused',
  'expired',
  'cancelled',
] as const;

export type CustomDiscountStatusValue =
  (typeof CUSTOM_DISCOUNT_STATUS_VALUES)[number];

export const CUSTOM_DISCOUNT_TYPE_VALUES = [
  'percentage',
  'fixed_amount',
] as const;

export type CustomDiscountTypeValue =
  (typeof CUSTOM_DISCOUNT_TYPE_VALUES)[number];

/**
 * TypeORM entity for `custom_discounts` (B16). Schema is the SoT in
 * 1777890000000-B16CustomDiscounts.ts; this class only mirrors columns
 * for the ORM. RLS is handled at the migration level
 * (tenant_isolation policy + FORCE ROW LEVEL SECURITY).
 */
@Entity({ name: 'custom_discounts' })
@Index('idx_custom_discounts_kg_status', ['kindergartenId', 'status'])
export class CustomDiscountTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'name', type: 'jsonb' })
  name!: Record<string, unknown>;

  @Column({ name: 'description', type: 'jsonb', nullable: true })
  description!: Record<string, unknown> | null;

  @Column({
    name: 'discount_type',
    type: 'enum',
    enum: CUSTOM_DISCOUNT_TYPE_VALUES,
    enumName: 'custom_discount_type',
  })
  discountType!: CustomDiscountTypeValue;

  @Column({
    name: 'amount',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: moneyKztTransformer,
  })
  amount!: MoneyKzt;

  @Column({ name: 'conditions', type: 'jsonb', default: () => `'{}'::jsonb` })
  conditions!: Record<string, unknown>;

  @Column({ name: 'target_type', type: 'varchar', default: 'all' })
  targetType!: string;

  @Column({
    name: 'target_ids',
    type: 'uuid',
    array: true,
    nullable: true,
  })
  targetIds!: string[] | null;

  @Column({ name: 'valid_from', type: 'timestamptz' })
  validFrom!: Date;

  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  validUntil!: Date | null;

  @Column({ name: 'max_uses_per_child', type: 'int', nullable: true })
  maxUsesPerChild!: number | null;

  @Column({ name: 'total_max_uses', type: 'int', nullable: true })
  totalMaxUses!: number | null;

  @Column({ name: 'used_count', type: 'int', default: 0 })
  usedCount!: number;

  @Column({ name: 'priority', type: 'int', default: 100 })
  priority!: number;

  @Column({ name: 'stackable', type: 'boolean', default: false })
  stackable!: boolean;

  @Column({ name: 'notify_on_activation', type: 'boolean', default: true })
  notifyOnActivation!: boolean;

  @Column({ name: 'notification_title', type: 'jsonb', nullable: true })
  notificationTitle!: Record<string, unknown> | null;

  @Column({ name: 'notification_body', type: 'jsonb', nullable: true })
  notificationBody!: Record<string, unknown> | null;

  @Column({
    name: 'status',
    type: 'enum',
    enum: CUSTOM_DISCOUNT_STATUS_VALUES,
    enumName: 'custom_discount_status',
    default: 'draft',
  })
  status!: CustomDiscountStatusValue;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

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
