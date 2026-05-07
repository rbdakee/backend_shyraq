import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../numeric.transformer';

export const REFUND_STATUS_VALUES = [
  'pending',
  'approved',
  'processed',
  'rejected',
] as const;

export type RefundStatusValue = (typeof REFUND_STATUS_VALUES)[number];

/**
 * `refunds` row. T4a creates the entity for `forFeature(...)` wiring; the
 * service (`refund.service`) lands in T5b.
 */
@Entity({ name: 'refunds' })
export class RefundTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId!: string;

  @Column({ name: 'invoice_id', type: 'uuid', nullable: true })
  invoiceId!: string | null;

  @Column({
    name: 'amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  amount!: number;

  @Column({ name: 'reason', type: 'text' })
  reason!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: REFUND_STATUS_VALUES,
    enumName: 'refund_status',
    default: 'pending',
  })
  status!: RefundStatusValue;

  @Column({ name: 'processed_by', type: 'uuid', nullable: true })
  processedBy!: string | null;

  @Column({ name: 'provider_ref', type: 'text', nullable: true })
  providerRef!: string | null;

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
