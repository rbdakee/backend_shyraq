import { Injectable, Logger } from '@nestjs/common';
import { WsBroadcaster } from '@/modules/notification/ws-broadcaster.port';
import { SocketIoServerProvider } from './socket-io-server.provider';

/**
 * Production WsBroadcaster — emits to a `socket.io` Server resolved through
 * `SocketIoServerProvider`. With `@socket.io/redis-adapter` attached, calling
 * `server.to(room).emit(...)` from any process publishes the event over
 * Redis pub/sub and reaches all api processes that have sockets in `room`.
 *
 * The `getServer()` lookup may transiently return `undefined` during boot
 * (gateway not yet attached) — we drop the broadcast with a debug log
 * rather than throw, since the dispatcher must not fail on transient WS
 * unavailability (history rows + push fan-out have already been written).
 */
@Injectable()
export class SocketIoWsBroadcaster extends WsBroadcaster {
  private readonly logger = new Logger(SocketIoWsBroadcaster.name);

  constructor(private readonly serverProvider: SocketIoServerProvider) {
    super();
  }

  broadcastToUser(userId: string, eventName: string, payload: unknown): void {
    this.emit(`user:${userId}`, eventName, payload);
  }

  broadcastToChild(childId: string, eventName: string, payload: unknown): void {
    this.emit(`child:${childId}`, eventName, payload);
  }

  broadcastToGroup(groupId: string, eventName: string, payload: unknown): void {
    this.emit(`group:${groupId}`, eventName, payload);
  }

  private emit(room: string, eventName: string, payload: unknown): void {
    const server = this.serverProvider.getServer();
    if (!server) {
      this.logger.debug(
        `ws_drop room=${room} event=${eventName} reason=server_unavailable`,
      );
      return;
    }
    try {
      server.to(room).emit(eventName, payload);
    } catch (err) {
      this.logger.warn(
        `ws_emit_failed room=${room} event=${eventName}: ${(err as Error).message}`,
      );
    }
  }
}
