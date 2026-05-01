import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `notifications` row — per-user history of dispatched notifications.
 * Tenant-scoped (FORCE RLS). Migration: `B9NotificationsAndOutbox`.
 */
@Entity({ name: 'notifications' })
export class NotificationTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 64 })
  event_key!: string;

  @Column({ type: 'jsonb' })
  title_i18n!: Record<string, string>;

  @Column({ type: 'jsonb' })
  body_i18n!: Record<string, string>;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  data!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  read_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
