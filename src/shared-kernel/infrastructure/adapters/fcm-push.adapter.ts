import { Injectable, Logger } from '@nestjs/common';
import {
  PushNotificationPort,
  PushPayload,
  PushTarget,
} from '../../domain/push-notification.port';

/**
 * FcmPushAdapter — placeholder. B22 will replace the body with real delivery
 * via `firebase-admin` once credentials are provisioned. Until then this
 * adapter logs the configuration mistake and throws so a misconfigured
 * `PUSH_PROVIDER=fcm` deployment fails loudly instead of silently dropping
 * notifications.
 *
 * The `firebase-admin` dependency is intentionally not added yet — pulling
 * it in pre-B22 wastes ~25MB of node_modules and forces a fake creds file
 * for every CI run.
 */
@Injectable()
export class FcmPushAdapter extends PushNotificationPort {
  private readonly logger = new Logger('FcmPushAdapter');

  send(_target: PushTarget, _payload: PushPayload): Promise<void> {
    this.logger.error('[FcmPush] not implemented (B22)');
    return Promise.reject(
      new Error(
        'FCM push adapter not yet implemented; configure PUSH_PROVIDER=mock',
      ),
    );
  }
}
