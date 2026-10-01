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

export interface CctvHideRuleRow {
  name: string;
  enabled: boolean;
  days: number[];
  from: string;
  to: string;
  all_cameras: boolean;
  camera_ids: string[];
}

@Entity({ name: 'cctv_display_policies' })
@Index('idx_cctv_display_policies_kg', ['kindergarten_id'], { unique: true })
export class CctvDisplayPolicyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid', array: true })
  common_camera_ids!: string[];

  // Small, always read whole with the row; jsonb keeps the parent hot path a
  // single-row lookup. Shape: `CctvHideRuleRow[]` (snake_case on purpose).
  @Column({ type: 'jsonb' })
  hide_rules!: CctvHideRuleRow[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
