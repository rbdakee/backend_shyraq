import { BadRequestException } from '@nestjs/common';
import {
  NotificationPreference,
  NotificationPreferenceFlags,
  NotificationPreferenceRepository,
  UpsertPreferenceItem,
} from './notification-preference.repository';
import {
  ListNotificationsInput,
  NotificationCreateInput,
  NotificationRepository,
  NotificationRow,
} from './notification.repository';
import {
  PushToken,
  PushTokenRepository,
  PushTokenSummary,
  PushTokenUpsertInput,
} from './push-token.repository';
import { NotificationService } from './notification.service';
import { PushTokenNotFoundError } from './domain/errors/push-token-not-found.error';
import { NotificationNotFoundError } from './domain/errors/notification-not-found.error';
import { InvalidEventKeyError } from './domain/errors/invalid-event-key.error';
import { CANONICAL_EVENT_KEYS } from './event-keys';

// ── UUIDs ────────────────────────────────────────────────────────────────────

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const KG = '11111111-1111-1111-1111-111111111111';
const TOKEN_ID_1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOTIF_ID_1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOTIF_ID_2 = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const NOW = new Date('2026-05-01T09:00:00.000Z');

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakePushTokenRepo extends PushTokenRepository {
  private tokens: Map<string, PushToken> = new Map();
  // Index by (platform, token) — global unique key (post B9 HIGH#3).
  private tokensByPlatformAndToken: Map<string, PushToken> = new Map();

  seed(token: PushToken): void {
    this.tokens.set(token.id, token);
    this.tokensByPlatformAndToken.set(
      `${token.platform}:${token.token}`,
      token,
    );
  }

  /** Test helper — exposes raw token rows for assertion. */
  allTokens(): PushToken[] {
    return Array.from(this.tokens.values());
  }

  findByUserIds(userIds: string[]): Promise<PushTokenSummary[]> {
    return Promise.resolve(
      Array.from(this.tokens.values())
        .filter((t) => userIds.includes(t.userId))
        .map((t) => ({
          id: t.id,
          userId: t.userId,
          platform: t.platform,
          token: t.token,
        })),
    );
  }

  upsert(input: PushTokenUpsertInput): Promise<PushToken> {
    const key = `${input.platform}:${input.token}`;
    const existing = this.tokensByPlatformAndToken.get(key);
    if (existing) {
      // ON CONFLICT (platform, token) DO UPDATE — transfer ownership: the
      // row's user_id is updated to the new caller. Pre-fix bug allowed
      // two rows with the same token under different user_ids; this
      // collapses them into a single row owned by the most recent caller.
      const updated: PushToken = {
        ...existing,
        userId: input.userId,
        appVersion: input.appVersion ?? null,
        deviceId: input.deviceId ?? null,
        lastSeenAt: new Date(),
      };
      this.tokens.set(existing.id, updated);
      this.tokensByPlatformAndToken.set(key, updated);
      return Promise.resolve(updated);
    }
    const newToken: PushToken = {
      id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: input.userId,
      token: input.token,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      deviceId: input.deviceId ?? null,
      lastSeenAt: new Date(),
      createdAt: new Date(),
    };
    this.tokens.set(newToken.id, newToken);
    this.tokensByPlatformAndToken.set(key, newToken);
    return Promise.resolve(newToken);
  }

  deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {
    const token = this.tokens.get(id);
    if (!token || token.userId !== userId) return Promise.resolve(false);
    this.tokens.delete(id);
    this.tokensByPlatformAndToken.delete(`${token.platform}:${token.token}`);
    return Promise.resolve(true);
  }

  deleteById(id: string): Promise<void> {
    const token = this.tokens.get(id);
    if (!token) return Promise.resolve();
    this.tokens.delete(id);
    this.tokensByPlatformAndToken.delete(`${token.platform}:${token.token}`);
    return Promise.resolve();
  }
}

class FakeNotificationRepo extends NotificationRepository {
  private rows: NotificationRow[] = [];

  seed(row: NotificationRow): void {
    this.rows.push(row);
  }

  createMany(rows: NotificationCreateInput[]): Promise<void> {
    for (const r of rows) {
      this.rows.push({
        id: r.id ?? `notif-${Date.now()}`,
        kindergartenId: r.kindergartenId,
        userId: r.userId,
        eventKey: r.eventKey,
        titleI18n: r.titleI18n,
        bodyI18n: r.bodyI18n,
        data: r.data,
        readAt: null,
        createdAt: r.createdAt,
      });
    }
    return Promise.resolve();
  }

  listForUser(input: ListNotificationsInput): Promise<NotificationRow[]> {
    let results = this.rows.filter(
      (r) =>
        r.kindergartenId === input.kindergartenId && r.userId === input.userId,
    );
    if (input.unreadOnly) {
      results = results.filter((r) => r.readAt === null);
    }
    if (input.cursor) {
      results = results.filter(
        (r) =>
          r.createdAt < input.cursor!.createdAt ||
          (r.createdAt.getTime() === input.cursor!.createdAt.getTime() &&
            r.id < input.cursor!.id),
      );
    }
    results.sort((a, b) => {
      if (b.createdAt > a.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      return b.id < a.id ? 1 : -1;
    });
    return Promise.resolve(results.slice(0, input.limit));
  }

  markRead(input: {
    kindergartenId: string;
    id: string;
    userId: string;
  }): Promise<NotificationRow | null> {
    const idx = this.rows.findIndex(
      (r) =>
        r.id === input.id &&
        r.userId === input.userId &&
        r.kindergartenId === input.kindergartenId,
    );
    if (idx === -1) return Promise.resolve(null);
    this.rows[idx] = { ...this.rows[idx], readAt: new Date() };
    return Promise.resolve(this.rows[idx]);
  }

  markAllRead(input: {
    kindergartenId: string;
    userId: string;
  }): Promise<number> {
    let count = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (
        r.kindergartenId === input.kindergartenId &&
        r.userId === input.userId &&
        r.readAt === null
      ) {
        this.rows[i] = { ...r, readAt: new Date() };
        count++;
      }
    }
    return Promise.resolve(count);
  }
}

class FakePreferenceRepo extends NotificationPreferenceRepository {
  private rows: NotificationPreference[] = [];

  findByUserIdsAndEventKey(
    userIds: string[],
    eventKey: string,
  ): Promise<Map<string, NotificationPreferenceFlags>> {
    const map = new Map<string, NotificationPreferenceFlags>();
    for (const row of this.rows) {
      if (userIds.includes(row.userId) && row.eventKey === eventKey) {
        map.set(row.userId, {
          push_enabled: row.pushEnabled,
          in_app_enabled: row.inAppEnabled,
        });
      }
    }
    return Promise.resolve(map);
  }

  listForUser(userId: string): Promise<NotificationPreference[]> {
    return Promise.resolve(this.rows.filter((r) => r.userId === userId));
  }

  upsertMany(
    userId: string,
    items: UpsertPreferenceItem[],
  ): Promise<NotificationPreference[]> {
    for (const item of items) {
      const idx = this.rows.findIndex(
        (r) => r.userId === userId && r.eventKey === item.eventKey,
      );
      if (idx >= 0) {
        this.rows[idx] = {
          ...this.rows[idx],
          pushEnabled: item.pushEnabled ?? this.rows[idx].pushEnabled,
          inAppEnabled: item.inAppEnabled ?? this.rows[idx].inAppEnabled,
          updatedAt: new Date(),
        };
      } else {
        this.rows.push({
          id: `pref-${Date.now()}-${item.eventKey}`,
          userId,
          eventKey: item.eventKey,
          pushEnabled: item.pushEnabled ?? true,
          inAppEnabled: item.inAppEnabled ?? true,
          updatedAt: new Date(),
        });
      }
    }
    return this.listForUser(userId);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeNotification(
  overrides: Partial<NotificationRow> = {},
): NotificationRow {
  return {
    id: NOTIF_ID_1,
    kindergartenId: KG,
    userId: USER_A,
    eventKey: 'attendance.checkin',
    titleI18n: { ru: 'Ребёнок пришёл' },
    bodyI18n: { ru: 'Айдар зачекинен' },
    data: {},
    readAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('NotificationService', () => {
  let service: NotificationService;
  let pushTokenRepo: FakePushTokenRepo;
  let notificationRepo: FakeNotificationRepo;
  let preferenceRepo: FakePreferenceRepo;

  beforeEach(() => {
    pushTokenRepo = new FakePushTokenRepo();
    notificationRepo = new FakeNotificationRepo();
    preferenceRepo = new FakePreferenceRepo();
    service = new NotificationService(
      pushTokenRepo,
      notificationRepo,
      preferenceRepo,
    );
  });

  // ── Push tokens ────────────────────────────────────────────────────────────

  describe('registerPushToken', () => {
    it('inserts a new token when none exists for the (platform, token) pair', async () => {
      const result = await service.registerPushToken(USER_A, {
        token: 'fcm-token-abc',
        platform: 'android',
        appVersion: '2.4.1',
        deviceId: 'device-1',
      });

      expect(result.userId).toBe(USER_A);
      expect(result.token).toBe('fcm-token-abc');
      expect(result.platform).toBe('android');
      expect(result.id).toBeDefined();
    });

    it('refreshes the same row when same user re-registers the same (platform, token)', async () => {
      const original: PushToken = {
        id: TOKEN_ID_1,
        userId: USER_A,
        token: 'fcm-token-abc',
        platform: 'ios',
        appVersion: '1.0.0',
        deviceId: null,
        lastSeenAt: new Date('2026-01-01'),
        createdAt: new Date('2026-01-01'),
      };
      pushTokenRepo.seed(original);

      const result = await service.registerPushToken(USER_A, {
        token: 'fcm-token-abc',
        platform: 'ios',
        appVersion: '2.0.0',
      });

      // Same underlying row — id unchanged.
      expect(result.id).toBe(TOKEN_ID_1);
      // App version updated.
      expect(result.appVersion).toBe('2.0.0');
      // last_seen_at refreshed.
      expect(result.lastSeenAt.getTime()).toBeGreaterThan(
        new Date('2026-01-01').getTime(),
      );
      // Still exactly ONE row total.
      expect(pushTokenRepo.allTokens()).toHaveLength(1);
    });

    it('transfers ownership when a different user re-registers the same (platform, token)', async () => {
      // User A previously registered the device — common when phone is
      // shared, sold, or re-flashed without proper logout flow.
      const original: PushToken = {
        id: TOKEN_ID_1,
        userId: USER_A,
        token: 'fcm-token-shared-device',
        platform: 'android',
        appVersion: '1.0.0',
        deviceId: 'device-shared',
        lastSeenAt: new Date('2026-01-01'),
        createdAt: new Date('2026-01-01'),
      };
      pushTokenRepo.seed(original);

      // User B logs in on the same physical device and re-registers the
      // same FCM token. Ownership must transfer atomically — only ONE row
      // remains, owned by user B. User A no longer receives push for this
      // device.
      const result = await service.registerPushToken(USER_B, {
        token: 'fcm-token-shared-device',
        platform: 'android',
      });

      expect(result.userId).toBe(USER_B);
      expect(result.token).toBe('fcm-token-shared-device');
      // Same underlying row id — atomic transfer, not a new insert.
      expect(result.id).toBe(TOKEN_ID_1);

      // CRITICAL: only ONE row in the store. The old (user_A, token) row
      // is gone — pre-fix bug had TWO rows here, leaking user A's push
      // notifications to a device user B now controls.
      const all = pushTokenRepo.allTokens();
      expect(all).toHaveLength(1);
      expect(all[0].userId).toBe(USER_B);
    });

    it('keeps two rows when same user registers the same token under different platforms', async () => {
      // Same token string under platform=ios AND platform=android — these
      // are independent rows (industry assumption: APNs/FCM/web tokens are
      // namespaced per platform). Pre-fix bug never affected this path.
      await service.registerPushToken(USER_A, {
        token: 'cross-platform-token',
        platform: 'ios',
      });
      await service.registerPushToken(USER_A, {
        token: 'cross-platform-token',
        platform: 'android',
      });

      const all = pushTokenRepo.allTokens();
      expect(all).toHaveLength(2);
      expect(all.map((t) => t.platform).sort()).toEqual(['android', 'ios']);
    });
  });

  describe('deletePushToken', () => {
    it('deletes a token owned by the caller', async () => {
      pushTokenRepo.seed({
        id: TOKEN_ID_1,
        userId: USER_A,
        token: 'tkn',
        platform: 'android',
        appVersion: null,
        deviceId: null,
        lastSeenAt: NOW,
        createdAt: NOW,
      });

      await expect(
        service.deletePushToken(TOKEN_ID_1, USER_A),
      ).resolves.toBeUndefined();
    });

    it('throws PushTokenNotFoundError when caller is not the owner', async () => {
      pushTokenRepo.seed({
        id: TOKEN_ID_1,
        userId: USER_B,
        token: 'tkn',
        platform: 'android',
        appVersion: null,
        deviceId: null,
        lastSeenAt: NOW,
        createdAt: NOW,
      });

      await expect(
        service.deletePushToken(TOKEN_ID_1, USER_A),
      ).rejects.toBeInstanceOf(PushTokenNotFoundError);
    });

    it('throws PushTokenNotFoundError when token id does not exist', async () => {
      await expect(
        service.deletePushToken('non-existent-id', USER_A),
      ).rejects.toBeInstanceOf(PushTokenNotFoundError);
    });
  });

  // ── Notification history ───────────────────────────────────────────────────

  describe('listNotifications', () => {
    beforeEach(() => {
      notificationRepo.seed(
        makeNotification({
          id: NOTIF_ID_1,
          createdAt: new Date('2026-05-01T09:00:00Z'),
          readAt: null,
        }),
      );
      notificationRepo.seed(
        makeNotification({
          id: NOTIF_ID_2,
          createdAt: new Date('2026-05-01T08:00:00Z'),
          readAt: new Date('2026-05-01T08:30:00Z'),
        }),
      );
    });

    it('returns all notifications (unread_only=false)', async () => {
      const result = await service.listNotifications({
        kindergartenId: KG,
        userId: USER_A,
        unreadOnly: false,
        limit: 20,
      });

      expect(result.items).toHaveLength(2);
    });

    it('filters to unread only when unread_only=true', async () => {
      const result = await service.listNotifications({
        kindergartenId: KG,
        userId: USER_A,
        unreadOnly: true,
        limit: 20,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(NOTIF_ID_1);
    });

    it('respects limit and returns next_cursor when page is full', async () => {
      const result = await service.listNotifications({
        kindergartenId: KG,
        userId: USER_A,
        unreadOnly: false,
        limit: 1,
      });

      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).not.toBeNull();
    });

    it('returns null next_cursor when results are fewer than limit', async () => {
      const result = await service.listNotifications({
        kindergartenId: KG,
        userId: USER_A,
        unreadOnly: false,
        limit: 20,
      });

      expect(result.nextCursor).toBeNull();
    });

    it('decodes and applies a cursor from the previous page', async () => {
      // Get first page of 1.
      const page1 = await service.listNotifications({
        kindergartenId: KG,
        userId: USER_A,
        unreadOnly: false,
        limit: 1,
      });

      expect(page1.nextCursor).not.toBeNull();

      // Second page should contain the older notification.
      const page2 = await service.listNotifications({
        kindergartenId: KG,
        userId: USER_A,
        unreadOnly: false,
        limit: 1,
        cursor: page1.nextCursor!,
      });

      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).toBe(NOTIF_ID_2);
    });

    it('throws BadRequestException for a malformed cursor', async () => {
      await expect(
        service.listNotifications({
          kindergartenId: KG,
          userId: USER_A,
          unreadOnly: false,
          limit: 20,
          cursor: 'not-valid-base64!!',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('markRead', () => {
    it('marks notification as read when caller is the owner', async () => {
      notificationRepo.seed(makeNotification({ id: NOTIF_ID_1, readAt: null }));

      const row = await service.markRead(KG, NOTIF_ID_1, USER_A);
      expect(row.id).toBe(NOTIF_ID_1);
      expect(row.readAt).not.toBeNull();
    });

    it('throws NotificationNotFoundError when not owned by caller', async () => {
      notificationRepo.seed(
        makeNotification({ id: NOTIF_ID_1, userId: USER_B }),
      );

      await expect(
        service.markRead(KG, NOTIF_ID_1, USER_A),
      ).rejects.toBeInstanceOf(NotificationNotFoundError);
    });

    it('throws NotificationNotFoundError when notification does not exist', async () => {
      await expect(
        service.markRead(KG, 'non-existent', USER_A),
      ).rejects.toBeInstanceOf(NotificationNotFoundError);
    });
  });

  describe('markAllRead', () => {
    it('returns the count of notifications marked as read', async () => {
      notificationRepo.seed(makeNotification({ id: NOTIF_ID_1, readAt: null }));
      notificationRepo.seed(
        makeNotification({
          id: NOTIF_ID_2,
          readAt: null,
          createdAt: new Date('2026-05-01T08:00:00Z'),
        }),
      );

      const count = await service.markAllRead(KG, USER_A);
      expect(count).toBe(2);
    });

    it('is idempotent (returns 0 on second call)', async () => {
      notificationRepo.seed(makeNotification({ id: NOTIF_ID_1, readAt: null }));
      await service.markAllRead(KG, USER_A);

      const count = await service.markAllRead(KG, USER_A);
      expect(count).toBe(0);
    });
  });

  // ── Notification preferences ────────────────────────────────────────────────

  describe('listPreferences', () => {
    it('returns one entry per canonical event key', async () => {
      const result = await service.listPreferences(USER_A);
      expect(result.preferences).toHaveLength(CANONICAL_EVENT_KEYS.length);
    });

    it('uses defaults (true/true) when no DB row exists', async () => {
      const result = await service.listPreferences(USER_A);
      for (const pref of result.preferences) {
        expect(pref.push_enabled).toBe(true);
        expect(pref.in_app_enabled).toBe(true);
      }
    });

    it('overrides defaults with stored values', async () => {
      await preferenceRepo.upsertMany(USER_A, [
        { eventKey: 'attendance.checkin', pushEnabled: false },
      ]);

      const result = await service.listPreferences(USER_A);
      const pref = result.preferences.find(
        (p) => p.event_key === 'attendance.checkin',
      );
      expect(pref?.push_enabled).toBe(false);
      expect(pref?.in_app_enabled).toBe(true); // default
    });
  });

  describe('updatePreferences', () => {
    it('rejects an unknown event_key with InvalidEventKeyError', async () => {
      await expect(
        service.updatePreferences(USER_A, {
          preferences: [{ event_key: 'totally.unknown' as never }],
        }),
      ).rejects.toBeInstanceOf(InvalidEventKeyError);
    });

    it('upserts a known event_key', async () => {
      const result = await service.updatePreferences(USER_A, {
        preferences: [{ event_key: 'attendance.checkin', push_enabled: false }],
      });

      const pref = result.preferences.find(
        (p) => p.event_key === 'attendance.checkin',
      );
      expect(pref?.push_enabled).toBe(false);
    });

    it('partial update: only supplied flag changes, other flag unchanged', async () => {
      // Seed with push_enabled=false, in_app_enabled=false.
      await preferenceRepo.upsertMany(USER_A, [
        {
          eventKey: 'attendance.checkin',
          pushEnabled: false,
          inAppEnabled: false,
        },
      ]);

      // Only update push_enabled back to true.
      const result = await service.updatePreferences(USER_A, {
        preferences: [{ event_key: 'attendance.checkin', push_enabled: true }],
      });

      const pref = result.preferences.find(
        (p) => p.event_key === 'attendance.checkin',
      );
      expect(pref?.push_enabled).toBe(true);
      expect(pref?.in_app_enabled).toBe(false); // unchanged
    });

    it('returns the full preference set (all canonical keys) after update', async () => {
      const result = await service.updatePreferences(USER_A, {
        preferences: [
          { event_key: 'progress_note.new', in_app_enabled: false },
        ],
      });

      expect(result.preferences).toHaveLength(CANONICAL_EVENT_KEYS.length);
    });
  });
});
