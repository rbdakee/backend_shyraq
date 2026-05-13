import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from '@/shared-kernel/infrastructure/typeorm/money-kzt.transformer';

/**
 * TypeORM entity for `custom_discount_applications` (B16). Immutable ledger
 * of which custom_discount was applied to which invoice + line_item for
 * which child, with the applied KZT amount.
 *
 * `applied_at` uses CreateDateColumn semantics; the migration declares it
 * as `timestamptz NOT NULL DEFAULT now()` with no UpdateDateColumn pair
 * (rows are insert-only).
 */
@Entity({ name: 'custom_discount_applications' })
@Index('idx_custom_discount_applications_discount_id', ['customDiscountId'])
@Index('idx_custom_discount_applications_invoice_id', ['invoiceId'])
@Index('idx_custom_discount_applications_child_discount', [
  'childId',
  'customDiscountId',
])
export class CustomDiscountApplicationTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'custom_discount_id', type: 'uuid' })
  customDiscountId!: string;

  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId!: string;

  @Column({ name: 'invoice_line_item_id', type: 'uuid', nullable: true })
  invoiceLineItemId!: string | null;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({
    name: 'amount_applied',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: moneyKztTransformer,
  })
  amountApplied!: MoneyKzt;

  @CreateDateColumn({
    name: 'applied_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  appliedAt!: Date;
}
