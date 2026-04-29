import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import {
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatusValue,
} from '../../../../domain/value-objects/enrollment-status.vo';
import { EnrollmentEntity } from './enrollment.entity';

/**
 * enrollment_status_log — append-only audit row of enrollment status
 * transitions. RLS-scoped on `kindergarten_id`. `from_status` is null only for
 * the synthetic creation transition (in practice the service writes the first
 * log row only on real status transitions, so from_status is non-null in
 * normal flow). `changed_by` references staff_members(id) ON DELETE RESTRICT
 * — log rows must outlive staff records.
 */
@Entity({ name: 'enrollment_status_log' })
@Index('idx_enrollment_log_enrollment', ['enrollment_id', 'created_at'])
export class EnrollmentStatusLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  enrollment_id!: string;

  @ManyToOne(() => EnrollmentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'enrollment_id', referencedColumnName: 'id' })
  enrollment?: EnrollmentEntity;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({
    type: 'enum',
    enum: ENROLLMENT_STATUS_VALUES,
    enumName: 'enrollment_status',
    nullable: true,
  })
  from_status!: EnrollmentStatusValue | null;

  @Column({
    type: 'enum',
    enum: ENROLLMENT_STATUS_VALUES,
    enumName: 'enrollment_status',
  })
  to_status!: EnrollmentStatusValue;

  @Column({ type: 'uuid' })
  changed_by!: string;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'changed_by', referencedColumnName: 'id' })
  changedByStaff?: StaffMemberEntity;

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
