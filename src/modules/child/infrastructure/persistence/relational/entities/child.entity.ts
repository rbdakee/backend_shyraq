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
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';

/**
 * children row. RLS-scoped on `kindergarten_id` (`tenant_isolation` policy
 * created by the migration). The (kindergarten_id, iin) partial-unique index
 * (`idx_children_iin_kindergarten WHERE iin IS NOT NULL`) enforces "one IIN
 * per kindergarten" without blocking IIN-less card-created rows.
 */
@Entity({ name: 'children' })
@Index('idx_children_kg', ['kindergarten_id'])
@Index('idx_children_kg_status', ['kindergarten_id', 'status'])
@Index('idx_children_group', ['current_group_id'])
export class ChildEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'char', length: 12, nullable: true })
  iin!: string | null;

  @Column({ type: 'varchar', length: 255 })
  full_name!: string;

  @Column({ type: 'date' })
  date_of_birth!: Date;

  @Column({ type: 'char', length: 1, nullable: true })
  gender!: string | null;

  @Column({ type: 'text', nullable: true })
  photo_url!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'card_created' })
  status!: 'card_created' | 'active' | 'archived';

  @Column({ type: 'uuid', nullable: true })
  current_group_id!: string | null;

  @ManyToOne(() => GroupEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_group_id', referencedColumnName: 'id' })
  currentGroup?: GroupEntity;

  @Column({ type: 'date', nullable: true })
  enrollment_date!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  archived_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  archive_reason!: string | null;

  @Column({ type: 'text', nullable: true })
  medical_notes!: string | null;

  @Column({ type: 'text', nullable: true })
  allergy_notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
