import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import {
  SLOT_CATEGORY_VALUES,
  SlotCategoryValue,
} from '../../../../domain/value-objects/slot-category.vo';
import { ScheduleTemplateEntity } from './schedule-template.entity';

/**
 * schedule_template_slots row — slots inside a template. No
 * `kindergarten_id` column (isolation is via parent FK), no timestamps. The
 * `(template_id, day_of_week, start_time)` partial-unique index is enforced
 * by the migration; the domain raises SlotConflictError up-front to give a
 * clean 409.
 */
@Entity({ name: 'schedule_template_slots' })
@Index('idx_schedule_template_slots_template', ['template_id'])
export class ScheduleTemplateSlotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  template_id!: string;

  @ManyToOne(() => ScheduleTemplateEntity, (t) => t.slots, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'template_id', referencedColumnName: 'id' })
  template?: ScheduleTemplateEntity;

  @Column({ type: 'varchar', length: 3 })
  day_of_week!: string;

  /**
   * PG `time` columns are returned as strings by node-postgres ("HH:MM:SS").
   * We type as string for round-trip fidelity.
   */
  @Column({ type: 'time' })
  start_time!: string;

  @Column({ type: 'time' })
  end_time!: string;

  @Column({ type: 'varchar', length: 120 })
  activity_name!: string;

  @Column({
    type: 'enum',
    enum: SLOT_CATEGORY_VALUES,
    enumName: 'slot_category',
    default: 'activity',
  })
  category!: SlotCategoryValue;

  @Column({ type: 'uuid', nullable: true })
  location_id!: string | null;

  @ManyToOne(() => LocationEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'location_id', referencedColumnName: 'id' })
  location?: LocationEntity;

  @Column({ type: 'text', nullable: true })
  description!: string | null;
}
