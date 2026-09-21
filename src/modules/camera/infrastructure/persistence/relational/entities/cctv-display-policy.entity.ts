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
import { CctvDisplayMode } from '../../../../domain/value-objects/cctv-display-mode.vo';

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

  // ISO weekdays, 1=Mon … 7=Sun. node-postgres hands smallint[] back as
  // strings on some driver versions, so the mapper coerces rather than
  // trusting the element type here.
  @Column({ type: 'smallint', array: true })
  work_days!: number[];

  @Column({ type: 'time' })
  opens_at!: string;

  @Column({ type: 'time' })
  closes_at!: string;

  @Column({ type: 'varchar', length: 16 })
  work_hours_mode!: CctvDisplayMode;

  @Column({ type: 'uuid', array: true })
  work_hours_camera_ids!: string[];

  @Column({ type: 'varchar', length: 16 })
  off_hours_mode!: CctvDisplayMode;

  @Column({ type: 'uuid', array: true })
  off_hours_camera_ids!: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
