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
import { GroupEntity } from './group.entity';

/**
 * group_mentors — append-only history of mentor assignments. The migration
 * creates a partial-unique index
 *   `idx_group_mentors_one_active ON group_mentors (group_id) WHERE unassigned_at IS NULL`
 * which is the source of truth for "one active mentor per group". Closing a
 * row (setting unassigned_at) happens in the same TX as inserting a new row.
 */
@Entity({ name: 'group_mentors' })
@Index('idx_group_mentors_kg', ['kindergarten_id'])
@Index('idx_group_mentors_group', ['group_id'])
@Index('idx_group_mentors_staff', ['staff_member_id'])
export class GroupMentorEntity {
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

  @Column({ type: 'uuid' })
  staff_member_id!: string;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'staff_member_id', referencedColumnName: 'id' })
  staffMember?: StaffMemberEntity;

  @Column({ type: 'boolean', default: true })
  is_primary!: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  assigned_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  unassigned_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
