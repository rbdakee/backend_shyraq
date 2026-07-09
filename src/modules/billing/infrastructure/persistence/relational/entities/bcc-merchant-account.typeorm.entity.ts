import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  BccConnectionResult,
  BccEnvironment,
  BccMerchantAccountStatus,
} from '../../../../domain/entities/bcc-merchant-account.entity';

@Entity({ name: 'bcc_merchant_accounts' })
export class BccMerchantAccountTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'merchant_id', type: 'varchar' })
  merchantId!: string;

  @Column({ name: 'terminal_id', type: 'varchar' })
  terminalId!: string;

  @Column({ name: 'merchant_name', type: 'varchar', nullable: true })
  merchantName!: string | null;

  @Column({ name: 'mac_key_enc', type: 'text' })
  macKeyEnc!: string;

  @Column({ name: 'environment', type: 'varchar', default: 'test' })
  environment!: BccEnvironment;

  @Column({ name: 'status', type: 'varchar', default: 'draft' })
  status!: BccMerchantAccountStatus;

  @Column({ name: 'callback_token_hash', type: 'char', length: 64 })
  callbackTokenHash!: string;

  @Column({ name: 'callback_token_enc', type: 'text' })
  callbackTokenEnc!: string;

  @Column({ name: 'notify_username', type: 'varchar' })
  notifyUsername!: string;

  @Column({ name: 'notify_password_hash', type: 'varchar' })
  notifyPasswordHash!: string;

  @Column({
    name: 'last_connection_checked_at',
    type: 'timestamptz',
    nullable: true,
  })
  lastConnectionCheckedAt!: Date | null;

  @Column({
    name: 'last_connection_result',
    type: 'jsonb',
    nullable: true,
  })
  lastConnectionResult!: BccConnectionResult | null;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

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
