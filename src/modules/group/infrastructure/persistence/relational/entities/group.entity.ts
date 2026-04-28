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
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';

@Entity({ name: 'groups' })
@Index('idx_groups_kg', ['kindergarten_id'])
@Index('idx_groups_location', ['current_location_id'])
export class GroupEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'integer' })
  capacity!: number;

  @Column({ type: 'integer', nullable: true })
  age_range_min!: number | null;

  @Column({ type: 'integer', nullable: true })
  age_range_max!: number | null;

  @Column({ type: 'uuid', nullable: true })
  current_location_id!: string | null;

  @ManyToOne(() => LocationEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'current_location_id', referencedColumnName: 'id' })
  currentLocation?: LocationEntity;

  @Column({ type: 'timestamptz', nullable: true })
  archived_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
