import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { OutboxEventStatusValue } from '../../../../domain/value-objects/outbox-event-status.vo';

/**
 * notification_outbox row. RLS-scoped on `kindergarten_id` (FORCE ROW LEVEL
 * SECURITY). Polling worker bypasses RLS via
 * `SET LOCAL app.bypass_rls = 'true'` because it must see every tenant.
 *
 * Migration: `1777627742228-B9NotificationsAndOutbox`. The partial index
 * `idx_outbox_pending` covers `(status, next_retry_at) WHERE status='pending'`
 * — only `pending` rows participate in polling, so terminal rows never
 * compete for the index. The migration owns the index (TypeORM cannot
 * express the `WHERE` clause via `@Index`), so this entity intentionally
 * declares no `@Index`.
 */
@Entity({ name: 'notification_outbox' })
export class OutboxEventTypeOrmEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  kindergarten_id!: string;

  @ManyToOne(() => KindergartenEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'kindergarten_id', referencedColumnName: 'id' })
  kindergarten?: KindergartenEntity;

  @Column({ type: 'varchar', length: 64 })
  event_key!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: OutboxEventStatusValue;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz' })
  next_retry_at!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  dispatched_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  failed_reason!: string | null;
}
