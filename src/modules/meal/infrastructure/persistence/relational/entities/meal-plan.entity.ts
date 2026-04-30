import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { MealItemEntity } from './meal-item.entity';

@Entity({ name: 'meal_plans' })
export class MealPlanEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergarten_id: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'date' })
  date: string;

  @Column({ name: 'group_id', type: 'uuid', nullable: true })
  group_id: string | null;

  @ManyToOne(() => GroupEntity, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'group_id', referencedColumnName: 'id' })
  group?: GroupEntity | null;

  @Column({ name: 'is_published', type: 'boolean', default: true })
  is_published: boolean;

  @Column({ type: 'jsonb', nullable: true })
  notes: object | null;

  @Column({ type: 'varchar', length: 40, default: 'manual' })
  source: string;

  @Column({ name: 'copied_from', type: 'uuid', nullable: true })
  copied_from: string | null;

  // Self-referencing FK to the source plan when this plan was produced by
  // copyWeekMenuToNext. Documentation-only on the read side — service code
  // sets `copied_from` directly via the column above. Mirrors the
  // `creator` ↔ `created_by` pattern below.
  @ManyToOne(() => MealPlanEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'copied_from', referencedColumnName: 'id' })
  copiedFromPlan?: MealPlanEntity | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  created_by: string | null;

  @ManyToOne(() => StaffMemberEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by', referencedColumnName: 'id' })
  creator?: StaffMemberEntity | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;

  @OneToMany(() => MealItemEntity, (item) => item.mealPlan, {
    cascade: ['insert', 'remove'],
  })
  items: MealItemEntity[];
}
