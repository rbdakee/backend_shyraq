import { OutboxEvent } from '../../../../domain/entities/outbox-event.entity';
import { OutboxEventTypeOrmEntity } from '../entities/outbox-event.typeorm.entity';

export class OutboxEventMapper {
  static toDomain(row: OutboxEventTypeOrmEntity): OutboxEvent {
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

  /**
   * Project a domain `OutboxEvent` into a flat row dict suitable for
   * `Repository.insert`. The relation field (`kindergarten`) is intentionally
   * omitted — TypeORM's `QueryDeepPartialEntity` rejects an embedded entity
   * unless it's a partial of the full graph; the FK column carries the link.
   * `id` is omitted when undefined so the DB default `gen_random_uuid()`
   * populates it.
   */
  static toPersistence(event: OutboxEvent): Record<string, unknown> {
    const state = event.toState();
    const row: Record<string, unknown> = {
      kindergarten_id: state.kindergartenId,
      event_key: state.eventKey,
      payload: state.payload,
      status: state.status,
      attempts: state.attempts,
      next_retry_at: state.nextRetryAt,
      created_at: state.createdAt,
      dispatched_at: state.dispatchedAt,
      failed_reason: state.failedReason,
    };
    if (event.id) {
      row.id = event.id;
    }
    return row;
  }
}
