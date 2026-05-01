import { BadRequestException, Injectable } from '@nestjs/common';
import {
  NotificationCursor,
  NotificationRepository,
  NotificationRow,
} from './notification.repository';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import {
  PushToken,
  PushTokenRepository,
  PushTokenUpsertInput,
} from './push-token.repository';
import { CANONICAL_EVENT_KEYS } from './event-keys';
import { NotificationNotFoundError } from './domain/errors/notification-not-found.error';
import { PushTokenNotFoundError } from './domain/errors/push-token-not-found.error';
import { InvalidEventKeyError } from './domain/errors/invalid-event-key.error';
import { NotificationPreferenceItemDto } from './dto/notification-preference.dto';
import type { ListPreferencesResponseDto } from './dto/list-preferences-response.dto';
import type { UpdatePreferencesDto } from './dto/update-preferences.dto';

const DEFAULT_LIMIT = 20;

export interface ListNotificationsOptions {
  kindergartenId: string;
  userId: string;
  unreadOnly?: boolean;
  limit?: number;
  /** Opaque base64 cursor from previous response. */
  cursor?: string;
}

export interface ListNotificationsResult {
  items: NotificationRow[];
  nextCursor: string | null;
}

@Injectable()
export class NotificationService {
  constructor(
    private readonly pushTokenRepo: PushTokenRepository,
    private readonly notificationRepo: NotificationRepository,
    private readonly preferenceRepo: NotificationPreferenceRepository,
  ) {}

  // ── Push tokens ──────────────────────────────────────────────────────────

  async registerPushToken(
    userId: string,
    input: Omit<PushTokenUpsertInput, 'userId'>,
  ): Promise<PushToken> {
    return this.pushTokenRepo.upsert({ ...input, userId });
  }

  async deletePushToken(id: string, userId: string): Promise<void> {
    const deleted = await this.pushTokenRepo.deleteByIdAndUserId(id, userId);
    if (!deleted) {
      throw new PushTokenNotFoundError(id);
    }
  }

  // ── Notification history ─────────────────────────────────────────────────

  async listNotifications(
    opts: ListNotificationsOptions,
  ): Promise<ListNotificationsResult> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    let cursor: NotificationCursor | undefined;

    if (opts.cursor) {
      cursor = this.decodeCursor(opts.cursor);
    }

    const rows = await this.notificationRepo.listForUser({
      kindergartenId: opts.kindergartenId,
      userId: opts.userId,
      unreadOnly: opts.unreadOnly ?? false,
      limit,
      cursor,
    });

    let nextCursor: string | null = null;
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      nextCursor = this.encodeCursor({
        createdAt: last.createdAt,
        id: last.id,
      });
    }

    return { items: rows, nextCursor };
  }

  async markRead(
    kindergartenId: string,
    notificationId: string,
    userId: string,
  ): Promise<NotificationRow> {
    const row = await this.notificationRepo.markRead({
      kindergartenId,
      id: notificationId,
      userId,
    });
    if (!row) {
      throw new NotificationNotFoundError(notificationId);
    }
    return row;
  }

  async markAllRead(kindergartenId: string, userId: string): Promise<number> {
    return this.notificationRepo.markAllRead({ kindergartenId, userId });
  }

  // ── Notification preferences ─────────────────────────────────────────────

  async listPreferences(userId: string): Promise<ListPreferencesResponseDto> {
    const stored = await this.preferenceRepo.listForUser(userId);
    const storedMap = new Map(stored.map((p) => [p.eventKey, p]));

    const preferences: NotificationPreferenceItemDto[] =
      CANONICAL_EVENT_KEYS.map((key) => {
        const row = storedMap.get(key);
        return {
          event_key: key,
          push_enabled: row?.pushEnabled ?? true,
          in_app_enabled: row?.inAppEnabled ?? true,
        };
      });

    return { preferences };
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<ListPreferencesResponseDto> {
    // Validate all keys upfront — reject if any is unknown.
    const canonicalSet = new Set<string>(CANONICAL_EVENT_KEYS);
    for (const item of dto.preferences) {
      if (!canonicalSet.has(item.event_key)) {
        throw new InvalidEventKeyError(item.event_key);
      }
    }

    await this.preferenceRepo.upsertMany(
      userId,
      dto.preferences.map((item) => ({
        eventKey: item.event_key,
        pushEnabled: item.push_enabled,
        inAppEnabled: item.in_app_enabled,
      })),
    );

    return this.listPreferences(userId);
  }

  // ── Cursor helpers ────────────────────────────────────────────────────────

  private encodeCursor(cursor: NotificationCursor): string {
    const json = JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    });
    return Buffer.from(json).toString('base64');
  }

  private decodeCursor(raw: string): NotificationCursor {
    let parsed: unknown;
    try {
      const json = Buffer.from(raw, 'base64').toString('utf-8');
      parsed = JSON.parse(json);
    } catch {
      throw new BadRequestException('invalid_cursor');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['createdAt'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['id'] !== 'string'
    ) {
      throw new BadRequestException('invalid_cursor');
    }

    const obj = parsed as { createdAt: string; id: string };
    const createdAt = new Date(obj.createdAt);
    if (isNaN(createdAt.getTime())) {
      throw new BadRequestException('invalid_cursor');
    }

    return { createdAt, id: obj.id };
  }
}
