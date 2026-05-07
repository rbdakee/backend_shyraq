import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../numeric.transformer';

@Entity({ name: 'tariff_assignments' })
export class TariffAssignmentTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({ name: 'tariff_plan_id', type: 'uuid' })
  tariffPlanId!: string;

  @Column({
    name: 'custom_amount',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  customAmount!: number | null;

  @Column({ name: 'custom_reason', type: 'text', nullable: true })
  customReason!: string | null;

  @Column({ name: 'valid_from', type: 'date' })
  validFrom!: Date | string;

  @Column({ name: 'valid_until', type: 'date', nullable: true })
  validUntil!: Date | string | null;

  @Column({ name: 'assigned_by', type: 'uuid' })
  assignedBy!: string;

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
