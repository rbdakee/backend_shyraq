import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { PushNotificationPort } from '@/shared-kernel/domain/push-notification.port';
import { OutboxEvent } from './domain/entities/outbox-event.entity';
import {
  NotificationCreateInput,
  NotificationRepository,
} from './notification.repository';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import { PushTokenRepository } from './push-token.repository';
import { WsBroadcaster } from './ws-broadcaster.port';

/**
 * Outcome of a single dispatcher run. The worker (T6) reads `status` to
 * decide between `markDispatched` (terminal success) and
 * `markFailedWithRetry` (transient — schedule retry, or terminal failed).
 */
export type DispatchResult =
  | { status: 'dispatched' }
  | { status: 'failed'; reason: string };

interface ResolvedRecipients {
  /** Distinct user-ids to fan-out to. */
  userIds: string[];
  /**
   * For each user, whether they are a `nanny` guardian on the underlying
   * child. Used by `applyNannyPolicy` — nannies are restricted to the
   * `attendance.*` and `pickup.*` event-keys.
   */
  nannyUserIds: Set<string>;
  /** Optional fan-out room ids for WS — informational, not used yet by T4. */
  childId?: string;
  groupId?: string;
}

interface NotificationTemplateArgs {
  payload: Record<string, unknown>;
}

interface NotificationTemplateResult {
  titleI18n: Record<string, string>;
  bodyI18n: Record<string, string>;
  /**
   * FCM-data is string-only — every value here must be a string. The
   * dispatcher passes this object verbatim into the push payload.
   */
  data: Record<string, string>;
}

type EventTemplate = (
  args: NotificationTemplateArgs,
) => NotificationTemplateResult;

/**
 * Set of event-keys nannies are allowed to receive. Anything outside this
 * set is silently dropped for users with `role='nanny'` on the underlying
 * child. `pickup.*` keys land here in B11; B9 leaves the placeholder so
 * nanny pickup notifications work without follow-up.
 */
const NANNY_ALLOWED_EVENT_KEYS = new Set<string>([
  'attendance.checkin',
  'attendance.checkout',
  'pickup.requested',
  'pickup.approved',
  'pickup.completed',
]);

const TEMPLATES: Record<string, EventTemplate> = {
  'attendance.checkin': ({ payload }) => ({
    titleI18n: {
      ru: 'Ребёнок прибыл в сад',
      kk: 'Бала балабақшаға келді',
      en: 'Child checked in',
    },
    bodyI18n: {
      ru: 'Регистрация прихода зафиксирована.',
      kk: 'Келу уақыты тіркелді.',
      en: 'Check-in recorded.',
    },
    data: stringMap({
      childId: payload.childId,
      eventId: payload.eventId,
      recordedAt: payload.recordedAt,
    }),
  }),

  'attendance.checkout': ({ payload }) => ({
    titleI18n: {
      ru: 'Ребёнок забран из сада',
      kk: 'Бала балабақшадан алынды',
      en: 'Child checked out',
    },
    bodyI18n: {
      ru: 'Регистрация ухода зафиксирована.',
      kk: 'Кету уақыты тіркелді.',
      en: 'Check-out recorded.',
    },
    data: stringMap({
      childId: payload.childId,
      eventId: payload.eventId,
      pickupUserId: payload.pickupUserId,
    }),
  }),

  'daily_status.changed': ({ payload }) => ({
    titleI18n: {
      ru: 'Статус ребёнка обновлён',
      kk: 'Баланың статусы жаңартылды',
      en: 'Daily status updated',
    },
    bodyI18n: {
      ru: `Новый статус: ${String(payload.status ?? '')}`,
      kk: `Жаңа статус: ${String(payload.status ?? '')}`,
      en: `New status: ${String(payload.status ?? '')}`,
    },
    data: stringMap({
      childId: payload.childId,
      date: payload.date,
      status: payload.status,
    }),
  }),

  'timeline.entry_created': ({ payload }) => ({
    titleI18n: {
      ru: 'Новая запись в ленте',
      kk: 'Жаңа жазба қосылды',
      en: 'New timeline entry',
    },
    bodyI18n: {
      ru: `Тип: ${String(payload.entryType ?? '')}`,
      kk: `Түрі: ${String(payload.entryType ?? '')}`,
      en: `Type: ${String(payload.entryType ?? '')}`,
    },
    data: stringMap({
      childId: payload.childId,
      entryId: payload.entryId,
      entryType: payload.entryType,
    }),
  }),

  'guardian.approved': ({ payload }) => ({
    titleI18n: {
      ru: 'Доступ к ребёнку подтверждён',
      kk: 'Балаға қол жетімділік расталды',
      en: 'Guardian access approved',
    },
    bodyI18n: {
      ru: 'Вам предоставлен доступ как опекуну.',
      kk: 'Сізге қамқоршы ретінде қолжетімділік берілді.',
      en: 'You now have guardian access.',
    },
    data: stringMap({
      childId: payload.childId,
      guardianUserId: payload.guardianUserId,
    }),
  }),

  'guardian.self_revoked': ({ payload }) => ({
    titleI18n: {
      ru: 'Связь с ребёнком отозвана',
      kk: 'Баламен байланыс жойылды',
      en: 'Guardian link removed',
    },
    bodyI18n: {
      ru: 'Вы отвязались от ребёнка.',
      kk: 'Сіз баладан байланысыңызды үздіңіз.',
      en: 'You unlinked from the child.',
    },
    data: stringMap({
      childId: payload.childId,
      userId: payload.userId,
    }),
  }),
};

function stringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * NotificationDispatcher — pure transform from a single outbox event into
 * the side-effects:
 *   1. resolve recipients (`event.eventKey` × `payload` → user-ids)
 *   2. apply the per-user notification_preferences filter
 *   3. apply the nanny-allowlist policy
 *   4. INSERT history rows for users with `in_app_enabled=true`
 *   5. WS broadcast to `user:{id}` rooms (fire-and-forget)
 *   6. Push fan-out to each user's tokens (per-user try/catch)
 *
 * Recipient-resolution rule (T4 scope):
 *   - `attendance.*`, `daily_status.changed`, `timeline.entry_created`:
 *     guardians of the child only. Mentors can view via API but do not
 *     receive a push for own-actor events. Documented in
 *     `docs/Shyraq BP.md §10`.
 *   - `guardian.approved` / `guardian.self_revoked`: the affected user only.
 *
 * The dispatcher does NOT call `outboxRepo.markDispatched` /
 * `markFailedWithRetry` itself — the worker (T6) owns that, with the lock
 * still held on the row from `claimBatch`. This keeps the dispatcher a pure
 * function `(event) → DispatchResult` and lets the worker decide retry
 * policy.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger('NotificationDispatcher');

  constructor(
    private readonly guardianRepo: ChildGuardianRepository,
    private readonly preferenceRepo: NotificationPreferenceRepository,
    private readonly pushTokenRepo: PushTokenRepository,
    private readonly notificationRepo: NotificationRepository,
    private readonly pushPort: PushNotificationPort,
    private readonly wsBroadcaster: WsBroadcaster,
    private readonly clock: ClockPort,
  ) {}

  async dispatch(event: OutboxEvent): Promise<DispatchResult> {
    try {
      const template = TEMPLATES[event.eventKey];
      if (!template) {
        return {
          status: 'failed',
          reason: `unknown_event_key:${event.eventKey}`,
        };
      }

      const recipients = await this.resolveRecipients(event);
      if (recipients.userIds.length === 0) {
        // Nothing to do — terminal success. Could legitimately happen if a
        // child's only guardian was revoked between enqueue and dispatch.
        return { status: 'dispatched' };
      }

      const filteredUserIds = this.applyNannyPolicy(
        event.eventKey,
        recipients.userIds,
        recipients.nannyUserIds,
      );
      if (filteredUserIds.length === 0) {
        return { status: 'dispatched' };
      }

      const preferences = await this.preferenceRepo.findByUserIdsAndEventKey(
        filteredUserIds,
        event.eventKey,
      );

      // Per-user effective flags (default both-enabled when no row).
      const effective = filteredUserIds.map((userId) => {
        const flags = preferences.get(userId) ?? {
          push_enabled: true,
          in_app_enabled: true,
        };
        return { userId, ...flags };
      });

      const inAppUsers = effective.filter((e) => e.in_app_enabled);
      const pushUsers = effective.filter((e) => e.push_enabled);

      // 4) history rows (in_app_enabled only) — single bulk insert.
      const rendered = template({ payload: event.payload });
      const now = this.clock.now();
      if (inAppUsers.length > 0) {
        const rows: NotificationCreateInput[] = inAppUsers.map((u) => ({
          id: randomUUID(),
          kindergartenId: event.kindergartenId,
          userId: u.userId,
          eventKey: event.eventKey,
          titleI18n: rendered.titleI18n,
          bodyI18n: rendered.bodyI18n,
          data: rendered.data,
          createdAt: now,
        }));
        await this.notificationRepo.createMany(rows);

        // 5) WS — fire-and-forget. Errors logged, do not abort dispatch.
        for (const u of inAppUsers) {
          try {
            this.wsBroadcaster.broadcastToUser(u.userId, event.eventKey, {
              title_i18n: rendered.titleI18n,
              body_i18n: rendered.bodyI18n,
              data: rendered.data,
            });
          } catch (err) {
            this.logger.warn(
              `ws_broadcast_failed user=${u.userId} event=${event.eventKey}: ${(err as Error).message}`,
            );
          }
        }
      }

      // 6) Push fan-out — load tokens once for every push-enabled user.
      if (pushUsers.length > 0) {
        const tokens = await this.pushTokenRepo.findByUserIds(
          pushUsers.map((u) => u.userId),
        );
        const tokensByUser = new Map<
          string,
          { id: string; platform: 'ios' | 'android' | 'web'; token: string }[]
        >();
        for (const t of tokens) {
          const arr = tokensByUser.get(t.userId) ?? [];
          arr.push({ id: t.id, platform: t.platform, token: t.token });
          tokensByUser.set(t.userId, arr);
        }

        const pushTitle =
          rendered.titleI18n.ru ?? Object.values(rendered.titleI18n)[0] ?? '';
        const pushBody =
          rendered.bodyI18n.ru ?? Object.values(rendered.bodyI18n)[0] ?? '';

        for (const u of pushUsers) {
          const userTokens = tokensByUser.get(u.userId);
          if (!userTokens || userTokens.length === 0) continue;
          try {
            await this.pushPort.send(
              { userId: u.userId, tokens: userTokens },
              {
                title: pushTitle,
                body: pushBody,
                data: rendered.data,
              },
            );
          } catch (err) {
            // Per-user push failure must NOT fail the whole dispatch.
            this.logger.warn(
              `push_send_failed user=${u.userId} event=${event.eventKey}: ${(err as Error).message}`,
            );
          }
        }
      }

      return { status: 'dispatched' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `dispatch_failed event=${event.eventKey} id=${event.id ?? '<unknown>'}: ${reason}`,
      );
      return { status: 'failed', reason };
    }
  }

  /**
   * Resolves the user-id set for an outbox event. Per the BP contract:
   *   - attendance / daily-status / timeline events → guardians of the
   *     child only. Mentors view via API; they do not receive a notification
   *     for own-actor events.
   *   - guardian.approved / guardian.self_revoked → the affected user only.
   */
  private async resolveRecipients(
    event: OutboxEvent,
  ): Promise<ResolvedRecipients> {
    switch (event.eventKey) {
      case 'attendance.checkin':
      case 'attendance.checkout':
      case 'daily_status.changed':
      case 'timeline.entry_created': {
        const childId = stringField(event.payload, 'childId');
        const guardians = await this.guardianRepo.findByChildId(
          event.kindergartenId,
          childId,
        );
        const userIds: string[] = [];
        const nannyUserIds = new Set<string>();
        for (const g of guardians) {
          const state = g.toState();
          if (state.status !== 'approved' || state.revokedAt !== null) {
            continue;
          }
          if (!userIds.includes(state.userId)) {
            userIds.push(state.userId);
          }
          if (state.role === 'nanny') {
            nannyUserIds.add(state.userId);
          }
        }
        return { userIds, nannyUserIds, childId };
      }

      case 'guardian.approved': {
        const userId = stringField(event.payload, 'guardianUserId');
        return { userIds: [userId], nannyUserIds: new Set() };
      }

      case 'guardian.self_revoked': {
        const userId = stringField(event.payload, 'userId');
        return { userIds: [userId], nannyUserIds: new Set() };
      }

      default:
        throw new Error(`recipient_resolver_missing:${event.eventKey}`);
    }
  }

  private applyNannyPolicy(
    eventKey: string,
    userIds: string[],
    nannyUserIds: Set<string>,
  ): string[] {
    if (NANNY_ALLOWED_EVENT_KEYS.has(eventKey)) {
      return userIds;
    }
    return userIds.filter((u) => !nannyUserIds.has(u));
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`payload_missing_field:${key}`);
  }
  return v;
}
