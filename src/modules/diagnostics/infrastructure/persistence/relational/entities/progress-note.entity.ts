import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * TypeORM mapping for the `progress_notes` table (B18 §8). Mirrors
 * migration `1777890003000-B18DiagnosticsAndProgress.ts` 1:1.
 *
 * Append-only: there is NO `updated_at` column (and no BEFORE UPDATE
 * trigger). Service-level `update()` issues a manual UPDATE that touches
 * only `body` / `media_urls`.
 */
@Entity({ name: 'progress_notes' })
@Index('idx_progress_notes_child_noted_at', ['childId', 'notedAt'])
@Index('idx_progress_notes_mentor_noted_at', ['mentorId', 'notedAt'])
export class ProgressNoteRelationalEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'child_id', type: 'uuid' })
  childId!: string;

  @Column({ name: 'mentor_id', type: 'uuid' })
  mentorId!: string;

  @Column({ name: 'body', type: 'text' })
  body!: string;

  @Column({ name: 'media_urls', type: 'text', array: true, nullable: true })
  mediaUrls!: string[] | null;

  @Column({ name: 'noted_at', type: 'timestamptz' })
  notedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /**
   * Optimistic-lock token (B22a T4). Bumped by the conditional UPDATE
   * in the relational repository's `update()` method. Internal only —
   * not exposed via DTO. Note that this table is otherwise append-only
   * (no `updated_at` column / trigger) — `row_version` is the sole
   * mutable bookkeeping field.
   */
  @Column({ name: 'row_version', type: 'int', default: 1 })
  rowVersion!: number;

  /**
   * Admin-bypass-on-PATCH audit columns (B22a T7 — closes B18 Concern 1).
   * Stamped on every PATCH (including the controller's admin-override
   * branch) by the service layer. Nullable: NULL on rows that have never
   * been patched. Internal only — not exposed via DTO in B22a.
   */
  @Column({ name: 'last_modified_by_user_id', type: 'uuid', nullable: true })
  lastModifiedByUserId!: string | null;

  @Column({ name: 'last_modified_at', type: 'timestamptz', nullable: true })
  lastModifiedAt!: Date | null;
}
