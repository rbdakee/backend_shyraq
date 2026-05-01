import { Global, Module } from '@nestjs/common';
import { WsBroadcaster } from '@/modules/notification/ws-broadcaster.port';
import { SocketIoServerProvider } from '@/websocket/socket-io-server.provider';
import { SocketIoWsBroadcaster } from '@/websocket/socket-io-ws-broadcaster';
import { WorkerSocketIoServerProvider } from './worker-socket-io-server.provider';

/**
 * WorkerWebsocketModule — worker-side counterpart of `WebsocketModule`.
 * Provides `WsBroadcaster` and `SocketIoServerProvider` symmetrically to
 * the api but bound to the publisher-only `WorkerSocketIoServerProvider`
 * (no HTTP listener, no `NotificationGateway` instantiation, no Auth
 * globals required).
 *
 * `@Global()` mirrors `WebsocketModule` so `NotificationDispatcher`
 * (registered inside `NotificationModule`) resolves `WsBroadcaster`
 * without an explicit import. The two modules are interchangeable from
 * the dispatcher's perspective — both export the same tokens.
 */
@Global()
@Module({
  providers: [
    {
      provide: SocketIoServerProvider,
      useClass: WorkerSocketIoServerProvider,
    },
    {
      provide: WsBroadcaster,
      useClass: SocketIoWsBroadcaster,
    },
  ],
  exports: [WsBroadcaster, SocketIoServerProvider],
})
export class WorkerWebsocketModule {}
