import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TemplateSchema } from '../../../../domain/schema-validators';

/**
 * TypeORM mapping for the `diagnostic_templates` table (B18 §8). Mirrors
 * migration `1777890003000-B18DiagnosticsAndProgress.ts` 1:1.
 *
 * `specialist_type` is plain varchar (no PG enum — staff_members defines
 * the canonical set and we keep it free-form for forward-compat).
 */
@Entity({ name: 'diagnostic_templates' })
@Index('idx_diagnostic_templates_kg_specialist_type', [
  'kindergartenId',
  'specialistType',
])
export class DiagnosticTemplateRelationalEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'specialist_type', type: 'varchar' })
  specialistType!: string;

  @Column({ name: 'name', type: 'varchar' })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'version', type: 'int', default: 1 })
  version!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'schema', type: 'jsonb' })
  schema!: TemplateSchema;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
