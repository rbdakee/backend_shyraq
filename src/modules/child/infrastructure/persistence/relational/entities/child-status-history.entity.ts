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
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { ChildEntity } from './child.entity';

/**
 * `child_status_history` — append-only audit log of `children.status`
 * transitions (B22a T9). RLS-scoped on `kindergarten_id`. CHECK constraints
 * `chk_valid_transition` and `chk_archive_reason_on_archive` enforce the
 * domain invariants at the storage boundary; see migration `B22ChildStatusHistory`
 * for full rationale.
 */
@Entity({ name: 'child_status_history' })
@Index('idx_child_status_history_kg_changed_at', [
  'kindergarten_id',
  'changed_at',
])
@Index('idx_child_status_history_child', ['child_id', 'changed_at'])
export class ChildStatusHistoryEntity {
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

  @Column({ type: 'varchar', length: 32 })
  previous_status!: 'card_created' | 'active' | 'archived';

  @Column({ type: 'varchar', length: 32 })
  new_status!: 'card_created' | 'active' | 'archived';

  @Column({ type: 'text', nullable: true })
  previous_archive_reason!: string | null;

  @Column({ type: 'text', nullable: true })
  archive_reason!: string | null;

  @Column({ type: 'uuid' })
  changed_by_user_id!: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'changed_by_user_id', referencedColumnName: 'id' })
  changedByUser?: UserEntity;

  @Column({ type: 'timestamptz' })
  changed_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
