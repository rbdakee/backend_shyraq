/**
 * WsBlocklistListenerService — service-unit suite (F15 Layer B).
 *
 * Drives `handleRevocation()` directly with hand-written in-memory fakes
 * for the events port and the gateway (no NestJS runtime, no Redis). The
 * load-bearing assertion: a published jti causes exactly the matching
 * sockets to receive `auth_error` + `disconnect(true)` and nothing else.
 */
import { TokenBlocklistEventsPort } from '@/modules/auth/token-blocklist.port';
import type { NotificationGateway } from './notification.gateway';
import { WsBlocklistListenerService } from './ws-blocklist-listener.service';

class FakeEventsPort extends TokenBlocklistEventsPort {
  handlers: ((jti: string) => void)[] = [];
  subscribe(handler: (jti: string) => void): Promise<() => void> {
    this.handlers.push(handler);
    return Promise.resolve(() => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    });
  }
  publish(jti: string): void {
    for (const h of this.handlers) h(jti);
  }
}

interface FakeSocket {
  id: string;
  jti: string;
  emitted: { event: string; payload: unknown }[];
  disconnected: boolean;
  emit: (event: string, payload: unknown) => void;
  disconnect: (close: boolean) => void;
}

function makeFakeSocket(id: string, jti: string): FakeSocket {
  const sock = {
    id,
    jti,
    emitted: [] as { event: string; payload: unknown }[],
    disconnected: false,
    emit(event: string, payload: unknown): void {
      sock.emitted.push({ event, payload });
    },
    disconnect(_close: boolean): void {
      sock.disconnected = true;
    },
  } as FakeSocket;
  return sock;
}

class FakeGateway {
  byJti = new Map<string, FakeSocket[]>();
  revokeCalls: string[] = [];

  index(socket: FakeSocket): void {
    const list = this.byJti.get(socket.jti) ?? [];
    list.push(socket);
    this.byJti.set(socket.jti, list);
  }

  revokeJti(jti: string): number {
    this.revokeCalls.push(jti);
    const sockets = this.byJti.get(jti) ?? [];
    for (const s of sockets) {
      s.emit('auth_error', { message: 'session_revoked' });
      s.disconnect(true);
    }
    return sockets.length;
  }
}

describe('WsBlocklistListenerService', () => {
  it('subscribes on init and disconnects every matching-jti socket on event', async () => {
    const events = new FakeEventsPort();
    const gateway = new FakeGateway();
    const listener = new WsBlocklistListenerService(
      events,
      gateway as unknown as NotificationGateway,
    );

    const sockA = makeFakeSocket('a', 'jti-1');
    const sockB = makeFakeSocket('b', 'jti-1');
    const sockC = makeFakeSocket('c', 'jti-2');
    gateway.index(sockA);
    gateway.index(sockB);
    gateway.index(sockC);

    await listener.onModuleInit();
    expect(events.handlers.length).toBe(1);

    events.publish('jti-1');

    expect(gateway.revokeCalls).toEqual(['jti-1']);
    // Both jti-1 sockets revoked.
    expect(sockA.disconnected).toBe(true);
    expect(sockB.disconnected).toBe(true);
    expect(sockA.emitted).toEqual([
      { event: 'auth_error', payload: { message: 'session_revoked' } },
    ]);
    expect(sockB.emitted).toEqual([
      { event: 'auth_error', payload: { message: 'session_revoked' } },
    ]);
    // jti-2 untouched.
    expect(sockC.disconnected).toBe(false);
    expect(sockC.emitted).toEqual([]);
  });

  it('ignores non-string payloads without throwing', async () => {
    const events = new FakeEventsPort();
    const gateway = new FakeGateway();
    const listener = new WsBlocklistListenerService(
      events,
      gateway as unknown as NotificationGateway,
    );
    await listener.onModuleInit();

    listener.handleRevocation('' as string);
    listener.handleRevocation(undefined as unknown as string);
    listener.handleRevocation(123 as unknown as string);

    expect(gateway.revokeCalls).toEqual([]);
  });

  it('survives a gateway throwing — error path is logged, no rethrow', async () => {
    const events = new FakeEventsPort();
    const gateway = {
      revokeJti(): number {
        throw new Error('boom');
      },
    };
    const listener = new WsBlocklistListenerService(
      events,
      gateway as unknown as NotificationGateway,
    );
    await listener.onModuleInit();

    // Must not throw. Pub/sub callback errors that escape would crash
    // the ioredis subscriber loop in production.
    expect(() => listener.handleRevocation('jti-1')).not.toThrow();
  });

  it('unsubscribes on module destroy', async () => {
    const events = new FakeEventsPort();
    const gateway = new FakeGateway();
    const listener = new WsBlocklistListenerService(
      events,
      gateway as unknown as NotificationGateway,
    );
    await listener.onModuleInit();
    expect(events.handlers.length).toBe(1);

    await listener.onModuleDestroy();
    expect(events.handlers.length).toBe(0);
  });
});
