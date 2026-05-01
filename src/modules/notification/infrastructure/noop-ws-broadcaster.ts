import { Injectable, Logger } from '@nestjs/common';
import { WsBroadcaster } from '../ws-broadcaster.port';

/**
 * Placeholder `WsBroadcaster` for T4. Logs each broadcast call but does not
 * push anything to a socket. T5 will replace this with a real socket.io
 * gateway-backed implementation living in `src/websocket/`.
 *
 * Bound in `NotificationModule.providers` so the dispatcher can be wired
 * end-to-end in T4 without waiting on T5.
 */
@Injectable()
export class NoopWsBroadcaster extends WsBroadcaster {
  private readonly logger = new Logger('NoopWsBroadcaster');

  broadcastToUser(userId: string, eventName: string, payload: unknown): void {
    this.logger.debug(
      `[NoopWS] room=user:${userId} event=${eventName} payload=${this.stringify(payload)}`,
    );
  }

  broadcastToChild(childId: string, eventName: string, payload: unknown): void {
    this.logger.debug(
      `[NoopWS] room=child:${childId} event=${eventName} payload=${this.stringify(payload)}`,
    );
  }

  broadcastToGroup(groupId: string, eventName: string, payload: unknown): void {
    this.logger.debug(
      `[NoopWS] room=group:${groupId} event=${eventName} payload=${this.stringify(payload)}`,
    );
  }

  private stringify(payload: unknown): string {
    try {
      return JSON.stringify(payload);
    } catch {
      return '<unserialisable>';
    }
  }
}
