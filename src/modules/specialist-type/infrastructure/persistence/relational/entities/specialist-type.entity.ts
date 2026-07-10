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

/**
 * Tenant-scoped `specialist_types` directory row. RLS policy `tenant_isolation`
 * (created in the SpecialistTypesDirectory migration) restricts visibility to
 * rows matching `current_setting('app.kindergarten_id')`, honouring the
 * SuperAdmin bypass GUC.
 *
 * Uniqueness `(kindergarten_id, code)` is enforced by the migration's UNIQUE
 * INDEX; the @@Index here documents intent (schema is driven by raw-SQL
 * migrations, not TypeORM synchronize).
 */
@Entity({ name: 'specialist_types' })
@Index('idx_specialist_types_kg_code', ['kindergarten_id', 'code'], {
  unique: true,
})
export class SpecialistTypeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ type: 'jsonb' })
  name_i18n!: Record<string, string>;

  @Column({ type: 'boolean', default: false })
  is_system!: boolean;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'integer', default: 0 })
  sort_order!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
