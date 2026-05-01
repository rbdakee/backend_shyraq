import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { OutboxEvent } from '../../../../domain/entities/outbox-event.entity';
import { OutboxEventStatusValue } from '../../../../domain/value-objects/outbox-event-status.vo';
import {
  EnqueueOutboxEventInput,
  OutboxEventRepository,
} from '../../../../outbox-event.repository';
import { OutboxEventTypeOrmEntity } from '../entities/outbox-event.typeorm-entity';
import { OutboxEventMapper } from '../mappers/outbox-event.mapper';

/**
 * Shape returned by `m.query(SELECT … FROM notification_outbox …)`. Column
 * names come back snake-cased exactly as declared in the migration.
 */
interface OutboxRow {
  id: string;
  kindergarten_id: string;
  event_key: string;
  payload: Record<string, unknown>;
  status: OutboxEventStatusValue;
  attempts: number;
  next_retry_at: Date | string;
  created_at: Date | string;
  dispatched_at: Date | string | null;
  failed_reason: string | null;
}

@Injectable()
export class OutboxEventRelationalRepository extends OutboxEventRepository {
  constructor(
    @InjectRepository(OutboxEventTypeOrmEntity)
    private readonly repo: Repository<OutboxEventTypeOrmEntity>,
  ) {
    super();
  }

  async enqueue(
    input: EnqueueOutboxEventInput,
    manager?: EntityManager,
  ): Promise<OutboxEvent> {
    const m = this.manager(manager);
    const id = randomUUID();
    const now = new Date();
    const event = OutboxEvent.create(
      {
        id,
        kindergartenId: input.kindergartenId,
        eventKey: input.eventKey,
        payload: input.payload,
      },
      now,
    );
    await m
      .getRepository(OutboxEventTypeOrmEntity)
      .insert(OutboxEventMapper.toPersistence(event));

    const row = await m
      .getRepository(OutboxEventTypeOrmEntity)
      .findOne({ where: { id } });
    if (!row) {
      throw new Error(`outbox_event_enqueue_readback_failed:${id}`);
    }
    return OutboxEventMapper.toDomain(row);
  }

  async claimBatch(
    manager: EntityManager,
    limit: number,
    now: Date,
  ): Promise<OutboxEvent[]> {
    // FOR UPDATE SKIP LOCKED is the canonical PostgreSQL pattern for a
    // worker-safe queue: the row-level lock prevents two pollers from
    // claiming the same row, and SKIP LOCKED keeps each poller's batch
    // disjoint instead of blocking. The lock is released only when the
    // surrounding transaction commits/rolls back, so the dispatcher must
    // call markDispatched / markFailedWithRetry on the same `manager`.
    const rows: OutboxRow[] = await manager.query(
      `SELECT id, kindergarten_id, event_key, payload, status, attempts,
              next_retry_at, created_at, dispatched_at, failed_reason
         FROM notification_outbox
        WHERE status = 'pending' AND next_retry_at <= $1
        ORDER BY next_retry_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((r) => this.rowToDomain(r));
  }

  async markDispatched(
    manager: EntityManager,
    id: string,
    now: Date,
  ): Promise<void> {
    await manager.query(
      `UPDATE notification_outbox
          SET status = 'dispatched', dispatched_at = $2
        WHERE id = $1`,
      [id, now],
    );
  }

  async markFailedWithRetry(
    manager: EntityManager,
    id: string,
    now: Date,
    reason: string,
    attempts: number,
    nextRetryAt: Date,
    terminal: boolean,
  ): Promise<void> {
    const status: OutboxEventStatusValue = terminal ? 'failed' : 'pending';
    await manager.query(
      `UPDATE notification_outbox
          SET status        = $2,
              attempts      = $3,
              next_retry_at = $4,
              failed_reason = $5
        WHERE id = $1`,
      [id, status, attempts, nextRetryAt, reason],
    );
    // `now` is currently informational — kept on the port signature so a
    // future schema migration that adds `last_attempt_at` does not require
    // a port change.
    void now;
  }

  async findById(id: string): Promise<OutboxEvent | null> {
    const row = await this.manager()
      .getRepository(OutboxEventTypeOrmEntity)
      .findOne({ where: { id } });
    return row ? OutboxEventMapper.toDomain(row) : null;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }

  private rowToDomain(row: OutboxRow): OutboxEvent {
    return OutboxEvent.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      eventKey: row.event_key,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      nextRetryAt:
        row.next_retry_at instanceof Date
          ? row.next_retry_at
          : new Date(row.next_retry_at),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
      dispatchedAt:
        row.dispatched_at == null
          ? null
          : row.dispatched_at instanceof Date
            ? row.dispatched_at
            : new Date(row.dispatched_at),
      failedReason: row.failed_reason,
    });
  }
}
