import * as admin from 'firebase-admin';
import { Injectable, Logger } from '@nestjs/common';
import {
  PushNotificationPort,
  PushPayload,
  PushTarget,
} from '../../domain/push-notification.port';
import { FirebaseConfig } from './firebase-push.config';

/**
 * Named firebase-admin app. Using a non-default name keeps the FCM app
 * isolated from any other `initializeApp()` call and makes the cached-app
 * lookup deterministic across `nest start --watch` reloads.
 */
const FCM_APP_NAME = 'shyraq-push';

/**
 * Minimal seam over `admin.messaging().send`. Injected by the adapter test so
 * unit specs never initialise a real firebase-admin app or hit the network —
 * mirrors the `WhatsAppCloudFetch` injection in `WhatsAppCloudSmsAdapter`.
 */
export interface FcmSender {
  send(message: admin.messaging.Message): Promise<string>;
}

/**
 * FcmPushAdapter — real push delivery via `firebase-admin` (FCM HTTP v1).
 *
 * The dispatcher (`NotificationDispatcher.fanoutPush`) calls `send` once per
 * device-token, wrapping each call in try/catch + `classifyPushError`. So this
 * adapter's contract is: deliver the payload to every token in `target.tokens`
 * (in practice a single token per call) and, on failure, THROW the underlying
 * firebase-admin error verbatim. Re-throwing untouched preserves the SDK's
 * `.code` (e.g. `messaging/registration-token-not-registered`) so the
 * classifier can tell a permanently-dead token (delete it) from a transient
 * outage (retry the whole outbox event).
 *
 * Selected at runtime by `pushPortProvider()` when `PUSH_PROVIDER=fcm`; the
 * `mock` provider (`MockPushAdapter`) stays the default for dev + tests.
 */
@Injectable()
export class FcmPushAdapter extends PushNotificationPort {
  private readonly logger = new Logger('FcmPushAdapter');
  private readonly sender: FcmSender;

  constructor(config: FirebaseConfig, sender?: FcmSender) {
    super();
    this.sender = sender ?? buildDefaultSender(config);
  }

  async send(target: PushTarget, payload: PushPayload): Promise<void> {
    for (const token of target.tokens) {
      const message: admin.messaging.Message = {
        token: token.token,
        notification: { title: payload.title, body: payload.body },
        // FCM rejects an empty `data` object on some SDK paths; only attach
        // it when there is at least one key. Values are already string-only
        // (the dispatcher's `stringMap` guarantees it).
        ...(payload.data && Object.keys(payload.data).length > 0
          ? { data: payload.data }
          : {}),
        android: { priority: 'high' },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default' } },
        },
      };

      try {
        const id = await this.sender.send(message);
        this.logger.log(
          `[FcmPush] sent user=${target.userId} platform=${token.platform} token=${token.id} id=${id}`,
        );
      } catch (err) {
        this.logger.warn(
          `[FcmPush] send failed user=${target.userId} token=${token.id}: ${(err as Error).message}`,
        );
        // Re-throw verbatim — the dispatcher's classifier reads `err.code`.
        throw err;
      }
    }
  }
}

/**
 * Lazily initialise (or reuse) the named firebase-admin app and return a
 * sender bound to its messaging instance. Reused across adapter instances in
 * the same process so we never hit the "app already exists" error.
 */
function buildDefaultSender(config: FirebaseConfig): FcmSender {
  const app = getOrInitApp(config);
  const messaging = admin.messaging(app);
  return { send: (message) => messaging.send(message) };
}

function getOrInitApp(config: FirebaseConfig): admin.app.App {
  const existing = admin.apps.find((a) => a?.name === FCM_APP_NAME);
  if (existing) {
    return existing;
  }
  return admin.initializeApp(
    {
      credential: admin.credential.cert({
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey,
      }),
    },
    FCM_APP_NAME,
  );
}
