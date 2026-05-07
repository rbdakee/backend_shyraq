import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * TypeORM mapping for the `diagnostic_entries` table (B18 §8). Mirrors
 * migration `1777890003000-B18DiagnosticsAndProgress.ts` 1:1.
 *
 * `assessment_date` is a calendar date (PG `date`); JS Date round-trips
 * with the time component pinned to midnight UTC.
 */
@Entity({ name: 'diagnostic_entries' })
@Index('idx_diagnostic_entries_child_date', ['childId', 'assessmentDate'])
@Index('idx_diagnostic_entries_kg_date', ['kindergartenId', 'assessmentDate'])
@Index('idx_diagnostic_entries_specialist_date', [
  'specialistId',
  'assessmentDate',
])
export class DiagnosticEntryRelationalEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId!: string;

  @Column({ name: 'specialist_id', type: 'uuid' })
  specialistId!: string;

  @Column({ name: 'assessment_date', type: 'date' })
  assessmentDate!: Date;

  @Column({ name: 'data', type: 'jsonb' })
  data!: Record<string, unknown>;

  @Column({ name: 'summary', type: 'text', nullable: true })
  summary!: string | null;

  @Column({ name: 'recommendations', type: 'text', nullable: true })
  recommendations!: string | null;

  @Column({ name: 'attachments', type: 'text', array: true, nullable: true })
  attachments!: string[] | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
