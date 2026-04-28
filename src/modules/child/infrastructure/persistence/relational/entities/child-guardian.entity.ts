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
import { ChildEntity } from './child.entity';

/**
 * child_guardians row. RLS-scoped on `kindergarten_id`. Uniqueness on
 * (child_id, user_id) is enforced via the migration's unique index — the
 * service performs an explicit pre-check so the resulting error code is
 * `guardian_already_exists` rather than a raw 23505 leak.
 */
@Entity({ name: 'child_guardians' })
@Index('idx_child_guardians_kg', ['kindergarten_id'])
@Index('idx_child_guardians_child', ['child_id'])
@Index('idx_child_guardians_user', ['user_id'])
@Index('idx_child_guardians_kg_status', ['kindergarten_id', 'status'])
export class ChildGuardianEntity {
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

  @Column({ type: 'uuid' })
  user_id!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id' })
  user?: UserEntity;

  @Column({ type: 'varchar', length: 32 })
  role!: 'primary' | 'secondary' | 'nanny';

  @Column({ type: 'varchar', length: 32, default: 'pending_approval' })
  status!: 'pending_approval' | 'approved' | 'rejected' | 'revoked';

  @Column({ type: 'boolean', default: false })
  has_approval_rights!: boolean;

  @Column({ type: 'uuid', nullable: true })
  approved_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revoked_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null;

  @Column({ type: 'boolean', default: true })
  can_pickup!: boolean;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  permissions!: Record<string, boolean>;

  @Column({ type: 'uuid', nullable: true })
  permissions_updated_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  permissions_updated_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
