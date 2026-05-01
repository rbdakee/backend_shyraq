import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import { NotificationGateway } from './notification.gateway';

/**
 * SocketIoServerProvider — abstract DI port that hands a `socket.io` Server
 * instance to consumers (`SocketIoWsBroadcaster`).
 *
 * Two concrete providers exist:
 *   - `GatewaySocketIoServerProvider` (api process) — returns the gateway's
 *     internal `@WebSocketServer()`. Calls to `server.to(room).emit(...)`
 *     reach locally-connected sockets directly + Redis-adapter-fan-out for
 *     other api processes.
 *   - `WorkerSocketIoServerProvider` (T6) — returns a standalone `new Server()`
 *     attached to the same Redis adapter. Used by the BullMQ worker to
 *     publish events without owning any HTTP socket.
 *
 * Implemented as `abstract class` (not `Symbol`/`@Inject('TOKEN')`) per
 * CLAUDE.md §4 ports & adapters rule.
 */
export abstract class SocketIoServerProvider {
  abstract getServer(): Server | undefined;
}

/**
 * api-process provider — defers to the gateway's socket.io Server. The
 * gateway boots when `app.listen()` runs, so during the very first
 * dispatch in test setup `getServer()` may return `undefined`. Callers
 * must null-check (the broadcaster does).
 */
@Injectable()
export class GatewaySocketIoServerProvider extends SocketIoServerProvider {
  constructor(private readonly gateway: NotificationGateway) {
    super();
  }

  getServer(): Server | undefined {
    return this.gateway.server;
  }
}
