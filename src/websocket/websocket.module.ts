import { Module } from '@nestjs/common';
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
 * services + the production `WsBroadcaster` impl.
 *
 * Imports `ChildModule` (for `ChildGuardianRepository` — auto-subscribe to
 * `child:{cid}`) and `GroupModule` (for `GroupRepository` — auto-subscribe
 * to `group:{gid}`). `JwtTokenPort` and `TokenBlocklistPort` come from the
 * global `AuthModule`.
 *
 * Re-exports `WsBroadcaster` so the global `NotificationModule` resolves
 * the production impl (replacing `NoopWsBroadcaster`).
 */
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
