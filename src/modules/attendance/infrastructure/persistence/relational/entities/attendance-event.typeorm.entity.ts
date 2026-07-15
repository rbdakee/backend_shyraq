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
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import {
  ATTENDANCE_EVENT_TYPE_VALUES,
  AttendanceEventTypeValue,
} from '../../../../domain/value-objects/attendance-event-type.vo';
import {
  ATTENDANCE_METHOD_VALUES,
  AttendanceMethodValue,
} from '../../../../domain/value-objects/attendance-method.vo';

/**
 * attendance_events row — check-in / check-out log. RLS-scoped on
 * `kindergarten_id`. The migration created indexes on
 *   (kindergarten_id, recorded_at DESC) and (child_id, recorded_at DESC) —
 * mirrored here as `@Index` for documentation; TypeORM does not own them.
 *
 * `pickup_request_id` is intentionally a plain UUID column with no FK in
 * B8 — B11 will ALTER TABLE to add REFERENCES pickup_requests(id).
 *
 * `deleted_at` is a plain nullable column, NOT TypeORM's `@DeleteDateColumn`.
 * That is deliberate: `@DeleteDateColumn` makes TypeORM filter soft-deleted
 * rows implicitly, which would silently diverge from the raw-SQL read paths
 * (`lastEventBucketsForDate`) that must spell the predicate out anyway. One
 * explicit `deleted_at IS NULL` per read path is easier to audit than a mix
 * of implicit and explicit filtering.
 */
@Entity({ name: 'attendance_events' })
@Index('idx_attendance_kg_recorded', ['kindergarten_id', 'recorded_at'])
@Index('idx_attendance_child_recorded', ['child_id', 'recorded_at'])
export class AttendanceEventTypeOrmEntity {
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
    enum: ATTENDANCE_EVENT_TYPE_VALUES,
    enumName: 'attendance_event_type',
  })
  event_type!: AttendanceEventTypeValue;

  @Column({
    type: 'enum',
    enum: ATTENDANCE_METHOD_VALUES,
    enumName: 'attendance_method',
  })
  method!: AttendanceMethodValue;

  @Column({ type: 'uuid', nullable: true })
  recorded_by!: string | null;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recorded_by', referencedColumnName: 'id' })
  recordedByStaff?: StaffMemberEntity;

  @Column({ type: 'uuid', nullable: true })
  pickup_user_id!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'pickup_user_id', referencedColumnName: 'id' })
  pickupUser?: UserEntity;

  // No FK in B8 — B11 will ALTER TABLE to add REFERENCES pickup_requests(id).
  @Column({ type: 'uuid', nullable: true })
  pickup_request_id!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'timestamptz' })
  recorded_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;
}
