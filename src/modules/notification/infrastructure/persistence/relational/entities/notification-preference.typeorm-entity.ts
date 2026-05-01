import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `notification_preferences` row — per-user per-event-key mute toggles.
 * Global (no RLS) — keyed on `user_id` only. Default flags assumed by the
 * dispatcher when no row is present: push_enabled=true, in_app_enabled=true.
 * Migration: `B9NotificationsAndOutbox`.
 */
@Entity({ name: 'notification_preferences' })
export class NotificationPreferenceTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 64 })
  event_key!: string;

  @Column({ type: 'boolean', default: true })
  push_enabled!: boolean;

  @Column({ type: 'boolean', default: true })
  in_app_enabled!: boolean;

  @Column({ type: 'timestamptz' })
  updated_at!: Date;
}
