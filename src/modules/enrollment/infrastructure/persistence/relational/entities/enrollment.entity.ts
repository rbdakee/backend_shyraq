import {
  Column,
  CreateDateColumn,
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
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatusValue,
} from '../../../../domain/value-objects/enrollment-status.vo';

/**
 * enrollments row — lead/inquiry aggregate. RLS-scoped on `kindergarten_id`
 * via the `tenant_isolation` policy created by EnrollmentTables migration. The
 * (kindergarten_id, child_iin) partial index `idx_enrollments_kg_iin` is
 * non-unique on purpose: many leads can share an IIN over time (e.g. a parent
 * cancels then re-applies); uniqueness is enforced on `children` only.
 */
@Entity({ name: 'enrollments' })
@Index('idx_enrollments_kg_status', ['kindergarten_id', 'status'])
@Index('idx_enrollments_kg_phone', ['kindergarten_id', 'contact_phone'])
export class EnrollmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid', nullable: true })
  child_id!: string | null;

  @ManyToOne(() => ChildEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'child_id', referencedColumnName: 'id' })
  child?: ChildEntity;

  @Column({ type: 'varchar' })
  contact_name!: string;

  @Column({ type: 'varchar' })
  contact_phone!: string;

  @Column({ type: 'varchar', nullable: true })
  child_name!: string | null;

  @Column({ type: 'date', nullable: true })
  child_dob!: Date | null;

  @Column({ type: 'char', length: 12, nullable: true })
  child_iin!: string | null;

  @Column({
    type: 'enum',
    enum: ENROLLMENT_STATUS_VALUES,
    enumName: 'enrollment_status',
  })
  status!: EnrollmentStatusValue;

  @Column({ type: 'varchar', nullable: true })
  source!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', nullable: true })
  assigned_to!: string | null;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_to', referencedColumnName: 'id' })
  assignedStaff?: StaffMemberEntity;

  @Column({ type: 'timestamptz' })
  status_changed_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
