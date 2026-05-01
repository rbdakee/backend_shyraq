import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `push_tokens` row — per-user device-token mapping. Global (no RLS) — keyed
 * on `user_id` only and accessed cross-tenant by the worker. Migration:
 * `B9NotificationsAndOutbox`.
 */
@Entity({ name: 'push_tokens' })
export class PushTokenTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @Column({ type: 'varchar', length: 512 })
  token!: string;

  @Column({ type: 'varchar', length: 16 })
  platform!: 'ios' | 'android' | 'web';

  @Column({ type: 'varchar', length: 32, nullable: true })
  app_version!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  device_id!: string | null;

  @Column({ type: 'timestamptz' })
  last_seen_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
