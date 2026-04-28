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
import { ChildEntity } from './child.entity';

/**
 * child_group_history — append-only audit log of group transfers. Each row
 * captures (from_group_id, to_group_id) at a point in time, the staff member
 * who performed the transfer, and an optional human-readable reason. RLS-
 * scoped on `kindergarten_id`.
 */
@Entity({ name: 'child_group_history' })
@Index('idx_child_group_history_kg', ['kindergarten_id'])
@Index('idx_child_group_history_child', ['child_id'])
export class ChildGroupHistoryEntity {
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

  @Column({ type: 'uuid', nullable: true })
  from_group_id!: string | null;

  @Column({ type: 'uuid', nullable: true })
  to_group_id!: string | null;

  @Column({ type: 'uuid' })
  transferred_by_staff_id!: string;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  transferred_at!: Date;
}
