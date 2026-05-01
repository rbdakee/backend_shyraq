import { Global, Module } from '@nestjs/common';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { WsBroadcaster } from '@/modules/notification/ws-broadcaster.port';
import { NotificationGateway } from './notification.gateway';
import {
  GatewaySocketIoServerProvider,
  SocketIoServerProvider,
} from './socket-io-server.provider';
import { SocketIoWsBroadcaster } from './socket-io-ws-broadcaster';
import { WsAutoSubscribeService } from './ws-auto-subscribe.service';
import { WsJwtGuard } from './ws-jwt.guard';

/**
 * WebsocketModule — owns the api-process WS gateway plus its supporting
 * services AND the production `WsBroadcaster` impl.
 *
 * This module is `@Global()` so its exports are visible to
 * `NotificationDispatcher` (registered inside `NotificationModule`)
 * without `NotificationModule` having to import it explicitly. The
 * worker process intentionally does NOT load this module — it imports
 * `WorkerWebsocketModule` instead, which mirrors the same exports
 * (`WsBroadcaster` + `SocketIoServerProvider`) but with a publisher-only
 * Server bound to the Redis pub/sub adapter and no gateway/auth deps.
 *
 * Imports `ChildModule` (for `ChildGuardianRepository` — auto-subscribe to
 * `child:{cid}`) and `GroupModule` (for `GroupRepository` — auto-subscribe
 * to `group:{gid}`). `JwtTokenPort` and `TokenBlocklistPort` come from the
 * global `AuthModule`.
 */
@Global()
@Module({
  imports: [ChildModule, GroupModule],
  providers: [
    NotificationGateway,
    WsAutoSubscribeService,
    WsJwtGuard,
    {
      provide: SocketIoServerProvider,
      useClass: GatewaySocketIoServerProvider,
    },
    {
      provide: WsBroadcaster,
      useClass: SocketIoWsBroadcaster,
    },
  ],
  exports: [WsBroadcaster, NotificationGateway, SocketIoServerProvider],
})
export class WebsocketModule {}
