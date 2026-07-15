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
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { ActivityEventOriginValue } from '../../../../domain/value-objects/activity-event-origin.vo';
import {
  ACTIVITY_EVENT_STATUS_VALUES,
  ActivityEventStatusValue,
} from '../../../../domain/value-objects/activity-event-status.vo';
import {
  SLOT_CATEGORY_VALUES,
  SlotCategoryValue,
} from '../../../../domain/value-objects/slot-category.vo';
import { ScheduleTemplateSlotEntity } from './schedule-template-slot.entity';

/**
 * activity_events row — concrete dated event projected from a slot, or an
 * ad-hoc event created by staff. RLS-scoped on `kindergarten_id`. Status
 * transitions update only the `status` column + `updated_at` — there are no
 * dedicated started_at/completed_at/cancelled_at columns.
 */
@Entity({ name: 'activity_events' })
@Index('idx_activity_events_kg_group_starts', [
  'kindergarten_id',
  'group_id',
  'starts_at',
])
@Index('idx_activity_events_group_starts', ['group_id', 'starts_at'])
@Index('idx_activity_events_kg', ['kindergarten_id'])
export class ActivityEventEntity {
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

  @Column({ type: 'uuid', nullable: true })
  template_slot_id!: string | null;

  @ManyToOne(() => ScheduleTemplateSlotEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'template_slot_id', referencedColumnName: 'id' })
  templateSlot?: ScheduleTemplateSlotEntity;

  /**
   * Durable provenance — survives the ON DELETE SET NULL above, which wipes
   * `template_slot_id` whenever a template edit deletes the originating slot.
   * varchar(20) + DB CHECK (see ActivityEventOrigin1784300000000), not an enum.
   * Write-once: never included in any UPDATE set.
   */
  @Column({ type: 'varchar', length: 20, default: 'template' })
  origin!: ActivityEventOriginValue;

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

  @Column({ type: 'timestamptz' })
  starts_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ends_at!: Date | null;

  @Column({
    type: 'enum',
    enum: ACTIVITY_EVENT_STATUS_VALUES,
    enumName: 'activity_event_status',
    default: 'scheduled',
  })
  status!: ActivityEventStatusValue;

  @Column({ type: 'uuid', nullable: true })
  created_by!: string | null;

  @ManyToOne(() => StaffMemberEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by', referencedColumnName: 'id' })
  createdByStaff?: StaffMemberEntity;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
