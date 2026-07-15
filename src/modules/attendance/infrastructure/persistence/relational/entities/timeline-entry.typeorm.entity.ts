import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import {
  TIMELINE_ENTRY_TYPE_VALUES,
  TimelineEntryTypeValue,
} from '../../../../domain/value-objects/timeline-entry-type.vo';
import { AttendanceEventTypeOrmEntity } from './attendance-event.typeorm.entity';

/**
 * timeline_entries row — append-friendly journal entry. RLS-scoped on
 * `kindergarten_id`. The migration created `idx_timeline_child_time` on
 * (child_id, entry_time DESC); mirrored here as `@Index` for documentation.
 */
@Entity({ name: 'timeline_entries' })
@Index('idx_timeline_child_time', ['child_id', 'entry_time'])
export class TimelineEntryTypeOrmEntity {
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

  @Column({
    type: 'enum',
    enum: TIMELINE_ENTRY_TYPE_VALUES,
    enumName: 'timeline_entry_type',
  })
  entry_type!: TimelineEntryTypeValue;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  media_urls!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'uuid', nullable: true })
  recorded_by!: string | null;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recorded_by', referencedColumnName: 'id' })
  recordedByStaff?: StaffMemberEntity;

  @Column({ type: 'timestamptz' })
  entry_time!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  /**
   * The attendance_events row this entry mirrors (check_in / check_out
   * entries only; null for standalone activity/meal/note entries). Lets the
   * admin attendance cascade find the paired entry when an event is deleted
   * or re-pointed at another child. Historical rows predating the column may
   * be null where the backfill could not match unambiguously.
   */
  @Column({ type: 'uuid', nullable: true })
  source_event_id!: string | null;

  @ManyToOne(() => AttendanceEventTypeOrmEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'source_event_id', referencedColumnName: 'id' })
  sourceEvent?: AttendanceEventTypeOrmEntity;
}
