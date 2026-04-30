import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';

/**
 * schedule_week_snapshots row — flag record marking that a group's weekly
 * schedule for `week_start_date` has been materialized into activity_events.
 * RLS-scoped on `kindergarten_id`. Unique on (group_id, week_start_date).
 */
@Entity({ name: 'schedule_week_snapshots' })
@Index('idx_schedule_week_snapshots_kg', ['kindergarten_id'])
@Index('idx_schedule_week_snapshots_group', ['group_id'])
export class ScheduleWeekSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid' })
  group_id!: string;

  @ManyToOne(() => GroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id', referencedColumnName: 'id' })
  group?: GroupEntity;

  @Column({ type: 'date' })
  week_start_date!: Date;

  @Column({ type: 'varchar', length: 40 })
  source!: string;

  @Column({ type: 'uuid', nullable: true })
  copied_from!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
