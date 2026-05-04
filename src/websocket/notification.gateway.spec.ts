/**
 * NotificationGateway — service-unit suite (F15 Layer A + Layer B-helper).
 *
 * Drives `handleConnection` / `handleDisconnect` directly with hand-written
 * fakes for `JwtTokenPort`, `TokenBlocklistPort`, `WsAutoSubscribeService`,
 * and a stub Socket. No NestJS runtime, no real socket.io — just the
 * load-bearing logic:
 *
 *   - Layer A: a per-socket setTimeout fires at `payload.exp * 1000` and
 *     calls `socket.disconnect(true)`.
 *   - Layer B helper: `revokeJti()` disconnects exactly the sockets whose
 *     stored jti matches, leaves others alone.
 */
import type {
  JwtTokenPort,
  VerifiedAccessClaims,
} from '@/modules/auth/jwt-token.port';
import type { TokenBlocklistPort } from '@/modules/auth/token-blocklist.port';
import type { WsAutoSubscribeService } from './ws-auto-subscribe.service';
import { NotificationGateway } from './notification.gateway';

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  handshake: { auth: { token?: string } };
  emitted: { event: string; payload: unknown }[];
  disconnected: boolean;
  emit: (event: string, payload: unknown) => void;
  disconnect: (close: boolean) => void;
}

function makeSocket(token?: string): FakeSocket {
  const sock = {
    id: 'sock-1',
    data: {} as Record<string, unknown>,
    handshake: { auth: token ? { token } : {} },
    emitted: [] as { event: string; payload: unknown }[],
    disconnected: false,
    emit(event: string, payload: unknown): void {
      sock.emitted.push({ event, payload });
    },
    disconnect(_close: boolean): void {
      sock.disconnected = true;
    },
  };
  return sock as FakeSocket;
}

function fakeJwt(payload: VerifiedAccessClaims): JwtTokenPort {
  return {
    issueAccessToken: () => {
      throw new Error('not impl');
    },
    decodeWithoutVerify: () => null,
    verifyAccessToken: () => Promise.resolve(payload),
  } as unknown as JwtTokenPort;
}

function fakeBlocklist(blocked: Set<string> = new Set()): TokenBlocklistPort {
  return {
    isBlocked: (jti: string) => Promise.resolve(blocked.has(jti)),
    blocklist: () => Promise.resolve(),
  } as unknown as TokenBlocklistPort;
}

const noopAutoSubscribe = {
  subscribe: () => Promise.resolve({ rooms: ['user:u-1'] }),
} as unknown as WsAutoSubscribeService;

const validClaims = (over: Partial<VerifiedAccessClaims> = {}) => ({
  sub: 'u-1',
  role: 'parent',
  kindergarten_id: 'kg-1',
  jti: 'jti-1',
  exp: Math.floor(Date.now() / 1000) + 60, // 60s in future
  ...over,
});

describe('NotificationGateway (F15)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('Layer A: schedules disconnect at payload.exp', async () => {
    // Use 60s into the future so the second-truncation in
    // Math.floor(Date.now()/1000) doesn't randomly bring the delay below
    // 60_000ms. We assert "not yet at 30s" then "yes by 70s" — bracketing
    // covers truncation jitter without making the test flaky.
    const claims = validClaims({
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const gateway = new NotificationGateway(
      fakeJwt(claims),
      fakeBlocklist(),
      noopAutoSubscribe,
    );
    const sock = makeSocket('any.token.here');
    await gateway.handleConnection(sock as never);

    expect(sock.disconnected).toBe(false);
    // Advance 30s — not yet (well before exp).
    jest.advanceTimersByTime(30 * 1000);
    expect(sock.disconnected).toBe(false);
    // Advance to 70s — past exp (60s).
    jest.advanceTimersByTime(40 * 1000);
    expect(sock.disconnected).toBe(true);
    expect(sock.emitted).toEqual(
      expect.arrayContaining([
        { event: 'auth_error', payload: { message: 'token_expired' } },
      ]),
    );
  });

  it('Layer A: caps the timer at 24h for absurd exp values', async () => {
    // exp 1 year out → cap should kick in. We can't easily assert "24h
    // exactly" without leaking the constant, but we can confirm the
    // socket isn't disconnected at 1ms past 24h would require advancing
    // 24h of fake time which is fine.
    const claims = validClaims({
      exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
    });
    const gateway = new NotificationGateway(
      fakeJwt(claims),
      fakeBlocklist(),
      noopAutoSubscribe,
    );
    const sock = makeSocket('any.token.here');
    await gateway.handleConnection(sock as never);

    // Just under 24h: not yet.
    jest.advanceTimersByTime(24 * 60 * 60 * 1000 - 1000);
    expect(sock.disconnected).toBe(false);
    // Cross 24h: cap fires.
    jest.advanceTimersByTime(2000);
    expect(sock.disconnected).toBe(true);
  });

  it('Layer A: handleDisconnect clears the pending timer', async () => {
    const claims = validClaims({
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const gateway = new NotificationGateway(
      fakeJwt(claims),
      fakeBlocklist(),
      noopAutoSubscribe,
    );
    const sock = makeSocket('any.token.here');
    await gateway.handleConnection(sock as never);
    expect(sock.data.expiryTimer).toBeDefined();

    gateway.handleDisconnect(sock as never);

    // Timer slot cleared so GC'ed.
    expect(sock.data.expiryTimer).toBeUndefined();
    // Advancing past exp must NOT re-disconnect (no second emit).
    sock.disconnected = false;
    sock.emitted = [];
    jest.advanceTimersByTime(120 * 1000);
    expect(sock.disconnected).toBe(false);
    expect(sock.emitted).toEqual([]);
  });

  it('Layer B: revokeJti disconnects matching sockets and leaves others alone', async () => {
    const gateway = new NotificationGateway(
      fakeJwt(validClaims({ jti: 'jti-A' })),
      fakeBlocklist(),
      noopAutoSubscribe,
    );

    // Connect socket A on jti-A.
    const sockA = makeSocket('any.token.here');
    sockA.id = 'sockA';
    await gateway.handleConnection(sockA as never);

    // Re-mint gateway-internal verifier for jti-B (we just need a different
    // claims payload for the second connection).
    const gatewayB = new NotificationGateway(
      fakeJwt(validClaims({ jti: 'jti-B' })),
      fakeBlocklist(),
      noopAutoSubscribe,
    );
    const sockB = makeSocket('any.token.here');
    sockB.id = 'sockB';
    await gatewayB.handleConnection(sockB as never);
    // Manually patch sockB into gateway under jti-B for the lookup test.
    (
      gateway as unknown as { socketsByJti: Map<string, Set<unknown>> }
    ).socketsByJti.set('jti-B', new Set([sockB]));

    // Reset captured events from the connect lifecycle (each handleConnection
    // emits `connected` via auto-subscribe — not what this test cares about).
    sockA.emitted = [];
    sockB.emitted = [];

    const count = gateway.revokeJti('jti-A');
    expect(count).toBe(1);
    expect(sockA.disconnected).toBe(true);
    expect(sockA.emitted).toEqual([
      { event: 'auth_error', payload: { message: 'session_revoked' } },
    ]);
    // jti-B unaffected.
    expect(sockB.disconnected).toBe(false);
    expect(sockB.emitted).toEqual([]);
  });

  it('Layer B: revokeJti for an unknown jti is a no-op', () => {
    const gateway = new NotificationGateway(
      fakeJwt(validClaims()),
      fakeBlocklist(),
      noopAutoSubscribe,
    );
    expect(gateway.revokeJti('nope')).toBe(0);
  });

  it('Connection rejected when blocklist already has the jti', async () => {
    const claims = validClaims({ jti: 'jti-revoked' });
    const blocked = new Set(['jti-revoked']);
    const gateway = new NotificationGateway(
      fakeJwt(claims),
      fakeBlocklist(blocked),
      noopAutoSubscribe,
    );
    const sock = makeSocket('any.token.here');
    await gateway.handleConnection(sock as never);
    expect(sock.disconnected).toBe(true);
    expect(sock.emitted).toEqual([
      { event: 'auth_error', payload: { message: 'unauthorized' } },
    ]);
    // No expiry timer scheduled — bailed before that step.
    expect(sock.data.expiryTimer).toBeUndefined();
  });

  it('Layer A: already-expired exp disconnects immediately', async () => {
    const claims = validClaims({
      exp: Math.floor(Date.now() / 1000) - 1, // already past
    });
    const gateway = new NotificationGateway(
      fakeJwt(claims),
      fakeBlocklist(),
      noopAutoSubscribe,
    );
    const sock = makeSocket('any.token.here');
    await gateway.handleConnection(sock as never);
    expect(sock.disconnected).toBe(true);
    expect(sock.emitted).toEqual(
      expect.arrayContaining([
        { event: 'auth_error', payload: { message: 'token_expired' } },
      ]),
    );
  });
});
