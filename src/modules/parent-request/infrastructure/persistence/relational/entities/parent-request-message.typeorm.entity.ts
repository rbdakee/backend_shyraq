import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `parent_request_messages` row — bidirectional thread entry for a parent
 * request. Exactly one of `author_user_id` / `author_staff_id` must be
 * non-null (XOR enforced by DB CHECK constraint and domain entity invariant).
 *
 * `attachments` uses `text[]` (PostgreSQL array) to match the migration
 * column definition.
 */
@Entity({ name: 'parent_request_messages' })
export class ParentRequestMessageTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'kindergarten_id', type: 'uuid' })
  kindergartenId!: string;

  @Column({ name: 'parent_request_id', type: 'uuid' })
  parentRequestId!: string;

  @Column({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId!: string | null;

  @Column({ name: 'author_staff_id', type: 'uuid', nullable: true })
  authorStaffId!: string | null;

  @Column({ name: 'body', type: 'text' })
  body!: string;

  @Column({ name: 'attachments', type: 'text', array: true, nullable: true })
  attachments!: string[] | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt!: Date;
}
