import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { ScheduleTemplateSlotEntity } from './schedule-template-slot.entity';

/**
 * schedule_templates row — weekly recurring schedule template. RLS-scoped on
 * `kindergarten_id` via the `tenant_isolation` policy created by
 * B7ScheduleAndMeal migration. `group_id` may be NULL for a kindergarten-wide
 * template.
 *
 * No `updated_at` column (per migration §2). `recurrence` is a varchar(20)
 * with DEFAULT 'weekly' — the domain only ever writes `'weekly'` for now,
 * but keeps the column for future extensibility.
 */
@Entity({ name: 'schedule_templates' })
@Index('idx_schedule_templates_kg_group_active', [
  'kindergarten_id',
  'group_id',
  'is_active',
])
@Index('idx_schedule_templates_kg', ['kindergarten_id'])
export class ScheduleTemplateEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'uuid', nullable: true })
  group_id!: string | null;

  @ManyToOne(() => GroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id', referencedColumnName: 'id' })
  group?: GroupEntity;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 20, default: 'weekly' })
  recurrence!: string;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'date' })
  valid_from!: Date;

  @Column({ type: 'date', nullable: true })
  valid_until!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @OneToMany(() => ScheduleTemplateSlotEntity, (s) => s.template)
  slots?: ScheduleTemplateSlotEntity[];
}
