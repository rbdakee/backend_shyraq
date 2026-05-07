import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../numeric.transformer';

export const PAYMENT_TYPE_VALUES = [
  'monthly',
  'prepayment_3m',
  'prepayment_6m',
  'prepayment_12m',
  'prepayment_24m',
  'additional_service',
  'late_pickup_fee',
  'other',
] as const;

export type PaymentTypeValue = (typeof PAYMENT_TYPE_VALUES)[number];

export const PAYMENT_STATUS_VALUES = [
  'pending',
  'partial',
  'paid',
  'overdue',
  'refunded',
  'cancelled',
] as const;

export type PaymentStatusValue = (typeof PAYMENT_STATUS_VALUES)[number];

@Entity({ name: 'invoices' })
export class InvoiceTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({ name: 'payment_account_id', type: 'uuid' })
  paymentAccountId!: string;

  @Column({ name: 'tariff_plan_id', type: 'uuid', nullable: true })
  tariffPlanId!: string | null;

  @Column({
    name: 'invoice_type',
    type: 'enum',
    enum: PAYMENT_TYPE_VALUES,
    enumName: 'payment_type',
  })
  invoiceType!: PaymentTypeValue;

  @Column({ name: 'period_start', type: 'date' })
  periodStart!: Date | string;

  @Column({ name: 'period_end', type: 'date' })
  periodEnd!: Date | string;

  @Column({
    name: 'amount_due',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  amountDue!: number;

  @Column({
    name: 'discount_pct',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  discountPct!: number | null;

  @Column({ name: 'discount_reason', type: 'text', nullable: true })
  discountReason!: string | null;

  @Column({
    name: 'amount_after_discount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  amountAfterDiscount!: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PAYMENT_STATUS_VALUES,
    enumName: 'payment_status',
    default: 'pending',
  })
  status!: PaymentStatusValue;

  @Column({ name: 'due_date', type: 'date' })
  dueDate!: Date | string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'prorated_for_days', type: 'smallint', nullable: true })
  proratedForDays!: number | null;

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
