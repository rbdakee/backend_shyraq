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

  /**
   * Optimistic-lock token (B22a T4). Bumped by the conditional UPDATE
   * in the relational repository's `update()` method. Internal only —
   * not exposed via DTO.
   */
  @Column({ name: 'row_version', type: 'int', default: 1 })
  rowVersion!: number;

  /**
   * Admin-bypass-on-PATCH audit columns (B22a T7 — closes B18 Concern 1).
   * Stamped on every PATCH (including the controller's admin-override
   * branch) by the service layer. Nullable: NULL on rows that have never
   * been patched (the create flow leaves them unset). Internal only —
   * not exposed via DTO in B22a; future surface deferred to B22b.
   */
  @Column({ name: 'last_modified_by_user_id', type: 'uuid', nullable: true })
  lastModifiedByUserId!: string | null;

  @Column({ name: 'last_modified_at', type: 'timestamptz', nullable: true })
  lastModifiedAt!: Date | null;
}
