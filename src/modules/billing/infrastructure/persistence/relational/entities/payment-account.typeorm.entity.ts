import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { moneyKztTransformer } from '@/shared-kernel/infrastructure/typeorm/money-kzt.transformer';

@Entity({ name: 'payment_accounts' })
export class PaymentAccountTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({
    name: 'balance',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: moneyKztTransformer,
  })
  balance!: MoneyKzt;

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
