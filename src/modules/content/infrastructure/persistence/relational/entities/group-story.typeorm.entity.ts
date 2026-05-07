import { Column, Entity, PrimaryColumn } from 'typeorm';
import { StoryMediaType } from '../../../../domain/entities/group-story.entity';

/**
 * TypeORM entity for `group_stories` (B17 §9.6). Mirrors the migration
 * `1777890002000-B17ContentAndStories.ts` exactly.
 *
 *   - `media_type` is a `varchar(16)` with a CHECK constraint
 *     (`media_type IN ('image','video')`) — the domain enforces the same.
 *   - `views` defaults to 0 in the DB; domain ctor enforces non-negative
 *     integer.
 *   - `expires_at` is `created_at + 24h` set by the domain `create()` and
 *     persisted verbatim; the DB does not compute it.
 */
@Entity({ name: 'group_stories' })
export class GroupStoryRelationalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergarten_id!: string;

  @Column({ name: 'group_id', type: 'uuid' })
  group_id!: string;

  @Column({ name: 'created_by', type: 'uuid' })
  created_by!: string;

  @Column({ name: 'media_url', type: 'text' })
  media_url!: string;

  @Column({ name: 'media_type', type: 'varchar', length: 16 })
  media_type!: StoryMediaType;

  @Column({ name: 'caption', type: 'text', nullable: true })
  caption!: string | null;

  @Column({ name: 'views', type: 'int', default: 0 })
  views!: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expires_at!: Date;

  @Column({ name: 'created_at', type: 'timestamptz' })
  created_at!: Date;
}
