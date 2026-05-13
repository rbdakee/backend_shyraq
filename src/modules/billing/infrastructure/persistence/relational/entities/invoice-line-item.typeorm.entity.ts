import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from '@/shared-kernel/infrastructure/typeorm/money-kzt.transformer';
import { numericTransformer } from '../numeric.transformer';

@Entity({ name: 'invoice_line_items' })
export class InvoiceLineItemTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'invoice_id', type: 'uuid' })
  invoiceId!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  @Column({ name: 'tariff_plan_id', type: 'uuid', nullable: true })
  tariffPlanId!: string | null;

  // `quantity` is a count (not money) — keep numeric transformer.
  @Column({
    name: 'quantity',
    type: 'numeric',
    precision: 8,
    scale: 2,
    default: 1,
    transformer: numericTransformer,
  })
  quantity!: number;

  @Column({
    name: 'unit_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: moneyKztTransformer,
  })
  unitPrice!: MoneyKzt;

  @Column({
    name: 'line_total',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: moneyKztTransformer,
  })
  lineTotal!: MoneyKzt;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;
}
