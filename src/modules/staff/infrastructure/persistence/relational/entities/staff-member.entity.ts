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
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';

export type StaffMemberRoleColumn =
  | 'admin'
  | 'mentor'
  | 'specialist'
  | 'reception';

/**
 * Tenant-scoped staff_members row. RLS policy `tenant_isolation` (created in
 * the StaffAndKindergartenSettings migration) restricts visibility to rows
 * matching `current_setting('app.kindergarten_id')`, with the SuperAdmin
 * bypass GUC honored.
 *
 * Composite uniqueness `(kindergarten_id, user_id)` is enforced by the
 * migration's UNIQUE INDEX (the @@unique here only documents intent — TypeORM
 * does not auto-create it because we drive schema via raw SQL migrations).
 */
@Entity({ name: 'staff_members' })
@Index('idx_staff_members_kg_role', ['kindergarten_id', 'role'])
@Index('idx_staff_members_user', ['user_id'])
export class StaffMemberEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid' })
  user_id!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id' })
  user?: UserEntity;

  @Column({ type: 'varchar', length: 32 })
  role!: StaffMemberRoleColumn;

  @Column({ type: 'varchar', length: 64, nullable: true })
  specialist_type!: string | null;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'date', nullable: true })
  hired_at!: string | null;

  @Column({ type: 'date', nullable: true })
  fired_at!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
