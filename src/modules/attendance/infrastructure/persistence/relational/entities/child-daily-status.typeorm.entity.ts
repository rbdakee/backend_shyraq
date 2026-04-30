import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import {
  CHILD_INTRADAY_STATUS_VALUES,
  ChildIntradayStatusValue,
} from '../../../../domain/value-objects/child-intraday-status.vo';

/**
 * child_daily_status row — one per (child_id, date), enforced by the unique
 * index `idx_daily_status_child_date`. RLS-scoped on `kindergarten_id`.
 *
 * `date` is stored as DB type `date` (no timezone) — TypeORM hydrates it as
 * a Date object pinned to UTC midnight. The mapper normalises both ways.
 */
@Entity({ name: 'child_daily_status' })
@Index('idx_daily_status_child_date', ['child_id', 'date'], { unique: true })
@Index('idx_daily_status_kg_date', ['kindergarten_id', 'date'])
export class ChildDailyStatusTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid' })
  child_id!: string;

  @ManyToOne(() => ChildEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'child_id', referencedColumnName: 'id' })
  child?: ChildEntity;

  @Column({ type: 'date' })
  date!: string;

  @Column({
    type: 'enum',
    enum: CHILD_INTRADAY_STATUS_VALUES,
    enumName: 'child_intraday_status',
    default: 'absent',
  })
  status!: ChildIntradayStatusValue;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid', nullable: true })
  set_by!: string | null;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'set_by', referencedColumnName: 'id' })
  setByStaff?: StaffMemberEntity;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
