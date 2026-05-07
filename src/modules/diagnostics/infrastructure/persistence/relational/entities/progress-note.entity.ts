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
}
