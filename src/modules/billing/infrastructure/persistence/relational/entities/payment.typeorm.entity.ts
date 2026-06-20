import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from '@/shared-kernel/infrastructure/typeorm/money-kzt.transformer';

export const PAYMENT_STATUS_V2_VALUES = [
  'initiated',
  'processing',
  'completed',
  'failed',
  'refunded',
] as const;

export type PaymentStatusV2Value = (typeof PAYMENT_STATUS_V2_VALUES)[number];

/**
 * `payments` row. The `provider` column is a free-text varchar guarded by a
 * CHECK constraint (see migration §7) — kept as `text` to allow B14+ vendors
 * (`halyk_epay`, `kaspi_pay`, etc.) without an enum migration.
 *
 * T4a creates the entity to wire `forFeature(...)`; the service that
 * consumes it (`payment.service`) lands in T5a.
 */
@Entity({ name: 'payments' })
export class PaymentTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({ name: 'payer_user_id', type: 'uuid', nullable: true })
  payerUserId!: string | null;

  @Column({
    name: 'amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: moneyKztTransformer,
  })
  amount!: MoneyKzt;

  @Column({ name: 'provider', type: 'text' })
  provider!: string;

  @Column({ name: 'provider_txn_id', type: 'text', nullable: true })
  providerTxnId!: string | null;

  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: PAYMENT_STATUS_V2_VALUES,
    enumName: 'payment_status_v2',
    default: 'initiated',
  })
  status!: PaymentStatusV2Value;

  @Column({ name: 'provider_payload', type: 'jsonb', nullable: true })
  providerPayload!: Record<string, unknown> | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ name: 'refund_id', type: 'uuid', nullable: true })
  refundId!: string | null;

  @Column({ name: 'refund_required', type: 'boolean', default: false })
  refundRequired!: boolean;

  @Column({ name: 'refund_reason', type: 'text', nullable: true })
  refundReason!: string | null;

  @Column({ name: 'duplicate_of_payment_id', type: 'uuid', nullable: true })
  duplicateOfPaymentId!: string | null;

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
